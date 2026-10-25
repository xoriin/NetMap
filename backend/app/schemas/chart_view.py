from typing import Literal
from pydantic import BaseModel, ConfigDict, StrictBool


class ChartViewOptions(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: Literal[1] = 1
    type: Literal[
        "default",
        "ring",
        "pie",
        "bars",
        "columns",
        "stacked",
        "line",
        "area",
        "dots",
        "treemap",
        "gauge",
        "number",
        "table",
    ] = "default"
    values: Literal["value", "percent", "both"] = "value"
    order: Literal["original", "largest", "smallest", "name"] = "original"
    position: Literal["top", "bottom", "left", "right", "side", "below"] = "side"
    legend: StrictBool = True
    labels: StrictBool = True
    tracks: StrictBool = True
