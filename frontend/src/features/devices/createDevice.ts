import { api, type Device, type DevicePayload } from "../../api/client";
import type { ConfirmOptions } from "../../components/ConfirmDialog";

type ConfirmAction = (options: ConfirmOptions) => Promise<boolean>;

type ReservationConflict = {
  code: "ip_reservation_conflict";
  reservation_id: number;
  ip_address: string;
  label: string;
  mac_address: string | null;
  can_claim: boolean;
};

function reservationConflict(error: unknown): ReservationConflict | null {
  if (!error || typeof error !== "object" || !("status" in error) || error.status !== 409
      || !("detail" in error) || !error.detail || typeof error.detail !== "object") {
    return null;
  }
  const detail = error.detail as Partial<ReservationConflict>;
  return detail.code === "ip_reservation_conflict"
    && typeof detail.reservation_id === "number"
    && typeof detail.ip_address === "string"
    && typeof detail.label === "string"
    && typeof detail.can_claim === "boolean"
    ? detail as ReservationConflict
    : null;
}

export async function createDeviceWithReservationConfirmation(
  accessToken: string,
  payload: DevicePayload,
  confirmAction: ConfirmAction,
): Promise<Device | null> {
  try {
    return await api.createDevice(accessToken, payload);
  } catch (error) {
    const conflict = reservationConflict(error);
    if (!conflict) throw error;
    if (!conflict.can_claim) {
      throw new Error(`IP address ${conflict.ip_address} is reserved for “${conflict.label}”. Your role cannot claim reservations.`);
    }
    const confirmed = await confirmAction({
      title: "Use reserved IP address?",
      message: `${conflict.ip_address} is reserved for “${conflict.label}”.`,
      detail: `${conflict.mac_address ? `Reserved MAC: ${conflict.mac_address}. ` : ""}Continuing will permanently delete the reservation and allocate the address to this device.`,
      confirmLabel: "Delete reservation and create device",
    });
    if (!confirmed) return null;
    return api.createDevice(accessToken, payload, true);
  }
}
