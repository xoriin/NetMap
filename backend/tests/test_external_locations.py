import pytest
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import Session
from app.main import app  # noqa: F401
from app.db.session import Base, _migrate_external_locations
from app.models.external_ip import ExternalIpAssignment, ExternalIpPool, ExternalIpRange, ExternalLocation, ExternalProviderAccount
from app.models.device import Device
from app.models.cloud import CloudProvider
from app.schemas.ipam import ExternalAccountCreate, ExternalLocationCreate
from app.api.v1.ipam import create_external_account, create_external_location, _location_fields, update_external_location, external_ip_summary, delete_external_location
from fastapi import HTTPException


def test_account_location_address_lifecycle():
    """Exercises the surviving account/location cascade logic against `ExternalIpPool`/
    `ExternalIpAssignment` rows built directly (Task 8 removed the pool/assignment
    endpoints themselves, but the legacy tables — and this cascade — remain as the
    rollback path, so the rows below stand in for what `create_external_ip_pool` and
    `create_external_ip_assignment` used to build)."""
    engine=create_engine('sqlite://')
    Base.metadata.create_all(engine)
    with Session(engine) as db:
        db.add(CloudProvider(id=1,key='azure',name='Azure',icon='azure'))
        db.add(Device(id=1,ip_address='10.0.0.1',status='online'))
        db.commit()
        accounts=[create_external_account(ExternalAccountCreate(provider_id=1,name=name),None,db) for name in ['Production','Development']]
        locations=[create_external_location(ExternalLocationCreate(account_id=a.id,name='Central US'),None,db) for a in accounts]
        pool=ExternalIpPool(name='Address', location_id=locations[0].id, **_location_fields(db, locations[0].id))
        db.add(pool)
        db.flush()
        db.add(ExternalIpRange(pool_id=pool.id, cidr='8.8.8.8/32'))
        db.commit()
        db.refresh(pool)
        assert pool.provider_id==1 and pool.account=='Production'
        address=ExternalIpAssignment(pool_id=pool.id, ip_address='8.8.8.8', device_id=1, url='https://example.com', label='', status='in_use')
        db.add(address)
        db.commit()
        db.refresh(address)
        assert address.label=='' and address.device_id==1
        for blank in ['', None]:
            address.status='available'
            address.label=(blank or '')
            address.device_id=address.asset_id=None
            db.commit()
            db.refresh(address)
            assert address.device_id is None and address.asset_id is None and address.label==''
            assert db.get(Device,1) is not None
            # external_ip_summary now counts the flat ExternalIpAddress register (Task 3),
            # which this legacy pool/assignment flow never populates.
            assert external_ip_summary(None,db).free==0
            address.status='in_use'
            address.device_id=1
            db.commit()
            db.refresh(address)
            assert address.device_id==1
        pool.location_id=locations[1].id
        for field, value in _location_fields(db, locations[1].id).items():
            setattr(pool, field, value)
        db.commit()
        db.refresh(pool)
        assert pool.account=='Development'
        # The legacy tables are frozen as the rollback snapshot: renaming a location
        # must no longer write through to its pools.
        update_external_location(locations[1].id,ExternalLocationCreate(account_id=accounts[1].id,name='East',region='Virginia'),None,db)
        assert db.get(ExternalIpPool,pool.id).region is None
        # The delete guard reads the live register, not this legacy pool, so a location
        # whose only tenant is a frozen pool row deletes cleanly.
        delete_external_location(locations[1].id,None,db)
        assert db.get(ExternalLocation,locations[1].id) is None
        assert db.get(ExternalIpAssignment,address.id).url=='https://example.com'


def test_location_can_be_created_without_a_provider_account():
    """The whole point of the rework: no provider account is a prerequisite.

    Exercises the real `ExternalLocation` model against a real session — a schema
    change alone would not catch `account_id` still being NOT NULL at the DB layer.
    """
    engine = create_engine('sqlite://')
    Base.metadata.create_all(engine)
    with Session(engine) as db:
        created = create_external_location(
            ExternalLocationCreate(account_id=None, name='Unassigned HQ'), None, db,
        )
        assert created.account_id is None

        fetched = db.get(ExternalLocation, created.id)
        assert fetched is not None
        assert fetched.account_id is None
        assert fetched.name == 'Unassigned HQ'


def test_location_migration_keeps_ambiguous_legacy_data_and_is_idempotent():
    engine=create_engine('sqlite://')
    with engine.begin() as conn:
        conn.execute(text('CREATE TABLE cloud_providers (id INTEGER PRIMARY KEY)'))
        conn.execute(text('CREATE TABLE external_ip_pools (id INTEGER PRIMARY KEY, provider_id INTEGER, account TEXT, name TEXT, service TEXT, region TEXT)'))
        conn.execute(text("INSERT INTO external_ip_pools VALUES (1, NULL, 'subscription A', 'WAN', 'EC2', 'Central US')"))
        conn.execute(text('CREATE TABLE external_ip_assignments (id INTEGER PRIMARY KEY, pool_id INTEGER, label TEXT, device_id INTEGER)'))
        conn.execute(text("INSERT INTO external_ip_assignments VALUES (1, 1, 'important label', 99)"))
        before=conn.execute(text('SELECT * FROM external_ip_pools')).all()
        _migrate_external_locations(conn,inspect(conn))
        _migrate_external_locations(conn,inspect(conn))
        assert conn.execute(text('SELECT id, provider_id, account, name, service, region FROM external_ip_pools')).all()==before
        assert conn.execute(text('SELECT location_id FROM external_ip_pools')).scalar() is None
        assert conn.execute(text('SELECT label, device_id FROM external_ip_assignments')).one()==('important label',99)
        assert conn.execute(text('SELECT COUNT(*) FROM external_provider_accounts')).scalar()==1
        assert conn.execute(text('SELECT COUNT(*) FROM external_locations')).scalar()==0


def test_location_migration_on_fresh_schema():
    engine=create_engine('sqlite://')
    Base.metadata.create_all(engine)
    with engine.begin() as conn:
        _migrate_external_locations(conn,inspect(conn))
        _migrate_external_locations(conn,inspect(conn))
        assert 'url' in {c['name'] for c in inspect(conn).get_columns('external_ip_assignments')}


def test_renaming_an_account_leaves_the_frozen_legacy_tables_untouched():
    """The legacy pool/range/assignment tables are this release's rollback path — they
    stay present, untouched and unread, so a rename must not write into them."""
    from app.api.v1.ipam import update_external_account, delete_external_account
    engine = create_engine('sqlite://')
    Base.metadata.create_all(engine)
    with Session(engine) as db:
        account = create_external_account(ExternalAccountCreate(name='Old account'), None, db)
        pool = ExternalIpPool(name='Legacy', account='Old account')
        db.add(pool)
        db.flush()
        db.add(ExternalIpRange(pool_id=pool.id, cidr='8.8.4.4/32'))
        db.commit()
        db.refresh(pool)
        update_external_account(account.id, ExternalAccountCreate(name='New account'), None, db)
        assert db.get(ExternalIpPool, pool.id).account == 'Old account'
        assert db.get(ExternalIpPool, pool.id).location_id is None
        assert db.get(ExternalProviderAccount, account.id).name == 'New account'
        # The account delete guard reads the live register, not this legacy pool, so an
        # account with no live locations or addresses deletes cleanly even though a
        # frozen `external_ip_pools` row's `account` text happens to match its old name.
        update_external_account(account.id, ExternalAccountCreate(name='Old account'), None, db)
        delete_external_account(account.id, None, db)
        assert db.get(ExternalProviderAccount, account.id) is None
        assert db.get(ExternalIpPool, pool.id).account == 'Old account'


def test_account_deletable_despite_matching_frozen_pool_when_no_live_data_remains():
    """Regression test for the account-delete guard bug: it used to query the frozen
    `external_ip_pools` table, so an accountless legacy pool whose `account` text
    happened to match an account's name produced a permanent 409 even though the
    account had no live locations or addresses. The guard must instead read the live
    register (`ExternalLocation`/`ExternalIpAddress`)."""
    from app.api.v1.ipam import delete_external_account
    from app.models.external_ip import ExternalIpAddress
    engine = create_engine('sqlite://')
    Base.metadata.create_all(engine)
    with Session(engine) as db:
        account = create_external_account(ExternalAccountCreate(name='Sandbox'), None, db)
        pool = ExternalIpPool(name='Legacy', account='Sandbox')
        db.add(pool)
        db.commit()

        # No live locations or addresses for this account: deletion must succeed.
        delete_external_account(account.id, None, db)
        assert db.get(ExternalProviderAccount, account.id) is None
        # The frozen pool row is left completely untouched.
        assert db.get(ExternalIpPool, pool.id).account == 'Sandbox'

        # Sanity check the other side: a live address reachable through the account's
        # location still blocks deletion.
        other_account = create_external_account(ExternalAccountCreate(name='Production'), None, db)
        location = create_external_location(ExternalLocationCreate(account_id=other_account.id, name='HQ'), None, db)
        db.add(ExternalIpAddress(ip_address='198.51.100.9', location_id=location.id, status='in_use'))
        db.commit()
        with pytest.raises(HTTPException) as exc:
            delete_external_account(other_account.id, None, db)
        assert exc.value.status_code == 409
        db.rollback()


def test_location_holding_addresses_cannot_be_deleted_but_an_empty_one_can():
    """The 409 guard must read the live register (`ExternalIpAddress.location_id`).

    It used to query the frozen legacy `external_ip_pools` table, so it never saw a
    real address: the delete succeeded, the location vanished, and its addresses kept
    a `location_id` pointing at nothing (there is no `PRAGMA foreign_keys=ON` in this
    app, so `ON DELETE SET NULL` never fires either).
    """
    from app.models.external_ip import ExternalIpAddress
    engine = create_engine('sqlite://')
    Base.metadata.create_all(engine)
    with Session(engine) as db:
        occupied = create_external_location(ExternalLocationCreate(account_id=None, name='Rack 1'), None, db)
        empty = create_external_location(ExternalLocationCreate(account_id=None, name='Rack 2'), None, db)
        for ip in ('203.0.113.1', '203.0.113.2', '203.0.113.3'):
            db.add(ExternalIpAddress(ip_address=ip, location_id=occupied.id, status='in_use'))
        db.commit()

        with pytest.raises(HTTPException) as exc:
            delete_external_location(occupied.id, None, db)
        assert exc.value.status_code == 409
        db.rollback()
        assert db.get(ExternalLocation, occupied.id) is not None
        assert db.query(ExternalIpAddress).filter_by(location_id=occupied.id).count() == 3

        delete_external_location(empty.id, None, db)
        assert db.get(ExternalLocation, empty.id) is None


def test_accountless_location_names_are_unique():
    """`account_id == NULL` is never true in SQL, so the old predicate let a user
    create the same accountless location twice — the primary path on a fresh install."""
    engine = create_engine('sqlite://')
    Base.metadata.create_all(engine)
    with Session(engine) as db:
        create_external_location(ExternalLocationCreate(account_id=None, name='Main datacentre'), None, db)
        with pytest.raises(HTTPException) as exc:
            create_external_location(ExternalLocationCreate(account_id=None, name='Main datacentre'), None, db)
        assert exc.value.status_code == 409
        db.rollback()
        assert db.query(ExternalLocation).filter_by(name='Main datacentre').count() == 1


def test_address_rejects_a_nonexistent_location_but_tolerates_a_dangling_device():
    """A bad `location_id` produces the same dangling state the delete guard prevents,
    so it is a 422. A bad `device_id` degrades safely to `device: null` and is allowed."""
    from app.api.v1.ipam import create_external_addresses, update_external_address
    from app.models.external_ip import ExternalIpAddress
    from app.schemas.ipam import ExternalIpAddressCreate, ExternalIpAddressUpdate
    engine = create_engine('sqlite://')
    Base.metadata.create_all(engine)
    with Session(engine) as db:
        with pytest.raises(HTTPException) as exc:
            create_external_addresses(
                ExternalIpAddressCreate(ip_address='198.51.100.1', location_id=999), db, None,
            )
        assert exc.value.status_code == 422
        db.rollback()
        assert db.query(ExternalIpAddress).count() == 0

        created = create_external_addresses(
            ExternalIpAddressCreate(ip_address='198.51.100.1', device_id=4242), db, None,
        )
        assert created[0].device is None

        with pytest.raises(HTTPException) as exc:
            update_external_address(created[0].id, ExternalIpAddressUpdate(location_id=999), db, None)
        assert exc.value.status_code == 422
        db.rollback()
        assert db.get(ExternalIpAddress, created[0].id).location_id is None
