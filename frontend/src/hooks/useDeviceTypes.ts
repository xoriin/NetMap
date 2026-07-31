import { useMemo } from "react";

import { api, type DeviceTypeOption } from "../api/client";
import { deviceTypeOptions } from "../constants";
import { useApiQuery } from "./useApiQuery";

export function useDeviceTypes(accessToken: string | null) {
  const query = useApiQuery(
    accessToken ? () => api.listDeviceTypes(accessToken) : null,
    [accessToken],
  );

  const options = useMemo<DeviceTypeOption[]>(() => {
    if (query.data && query.data.length > 0) return query.data;
    return deviceTypeOptions.map((value) => ({
      id: null,
      value,
      label: value,
      icon: value === "other" ? "device" : value,
      is_builtin: true,
      color: null,
    }));
  }, [query.data]);

  const values = useMemo(() => options.map((option) => option.value), [options]);

  return {
    ...query,
    options,
    values,
  };
}
