"""Turn lerobot-train log lines into metric rows.

lerobot-train prints one line every `log_freq` steps, e.g.
    INFO ... step:2K smpl:16K ep:40 epch:0.36 loss:0.512 grdn:12.345 lr:1.0e-05 updt_s:0.081 data_s:0.004
`step` is abbreviated (2K), so the exact step is counted from log_freq and only checked
against the printed value.
"""

import re

PUSH_MARKER = "Model pushed to "
_TOKEN = re.compile(r"([A-Za-z_/]+):(\S+)")
_SUFFIX = {"": 1, "K": 1e3, "M": 1e6, "B": 1e9}
NAMES = {
    "loss": "loss",
    "grdn": "grad_norm",
    "lr": "lr",
    "epch": "epochs",
    "updt_s": "update_s",
    "data_s": "dataloading_s",
    "prep_s": "preprocessing_s",
    "step_s": "step_s",
    "smp/s": "samples_per_s",
    "mem_gb": "gpu_mem_gb",
    "scale": "grad_scale",
}


def parse_big_number(text: str) -> float:
    m = re.fullmatch(r"(-?[\d.]+)([KMB]?)", text)
    if not m:
        raise ValueError(text)
    return float(m.group(1)) * _SUFFIX[m.group(2)]


class MetricParser:
    def __init__(self, log_freq: int, last_step: int = 0):
        self.log_freq = log_freq
        self.last_step = last_step

    def feed(self, line: str) -> tuple[int, dict] | None:
        """Return (step, values) for a training-metrics line, else None."""
        if " step:" not in line or " loss:" not in line:
            return None
        tokens = dict(_TOKEN.findall(line[line.index(" step:"):]))
        try:
            shown = parse_big_number(tokens.pop("step"))
        except (KeyError, ValueError):
            return None
        step = self.last_step + self.log_freq
        # A printed "2K" covers 1500..2499: trust our count only if it agrees (resumed runs don't).
        tolerance = 0.5 * 10 ** (3 * ((len(str(int(shown))) - 1) // 3)) if shown >= 1000 else 0
        if abs(step - shown) > tolerance:
            step = int(round(shown / self.log_freq) * self.log_freq)
        values = {}
        for key, raw in tokens.items():
            name = NAMES.get(key)
            if name is None:
                continue
            try:
                values[name] = float(raw)
            except ValueError:
                continue
        self.last_step = step
        return step, values
