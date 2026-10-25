"""Personal display preferences. Ownership always comes from the authenticated session."""

import re
from typing import Annotated
from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import ValidationError
from sqlalchemy import delete, select
from sqlalchemy.dialects.sqlite import insert
from sqlalchemy.orm import Session
from app.api.deps import get_current_user
from app.db.session import get_db
from app.models.chart_view import ChartView
from app.models.user import User
from app.schemas.chart_view import ChartViewOptions

router = APIRouter(prefix="/auth/me/chart-views", tags=["profile"])
CurrentUser = Annotated[User, Depends(get_current_user)]
Database = Annotated[Session, Depends(get_db)]


def _chart_id(chart_id: str) -> str:
    if not re.fullmatch(r"[a-z][a-z0-9._-]{0,119}", chart_id):
        raise HTTPException(status_code=422, detail="Invalid chart identifier")
    return chart_id


@router.get("", response_model=dict[str, ChartViewOptions])
def list_views(current_user: CurrentUser, db: Database) -> dict[str, ChartViewOptions]:
    result = {}
    for row in db.scalars(select(ChartView).where(ChartView.user_id == current_user.id)):
        try:
            result[row.chart_id] = ChartViewOptions.model_validate_json(row.options)
        except ValidationError:
            # Retired/incompatible preferences fall back to the current product default.
            continue
    return result


@router.put("/{chart_id}", response_model=ChartViewOptions)
def save_view(
    chart_id: str, options: ChartViewOptions, current_user: CurrentUser, db: Database
) -> ChartViewOptions:
    chart_id = _chart_id(chart_id)
    statement = insert(ChartView).values(
        user_id=current_user.id, chart_id=chart_id, options=options.model_dump_json()
    )
    db.execute(
        statement.on_conflict_do_update(
            index_elements=["user_id", "chart_id"], set_={"options": statement.excluded.options}
        )
    )
    db.commit()
    return options


@router.delete("/{chart_id}", status_code=204)
def reset_view(chart_id: str, current_user: CurrentUser, db: Database) -> Response:
    db.execute(
        delete(ChartView).where(
            ChartView.user_id == current_user.id, ChartView.chart_id == _chart_id(chart_id)
        )
    )
    db.commit()
    return Response(status_code=204)


@router.delete("", status_code=204)
def reset_all_views(current_user: CurrentUser, db: Database) -> Response:
    db.execute(delete(ChartView).where(ChartView.user_id == current_user.id))
    db.commit()
    return Response(status_code=204)
