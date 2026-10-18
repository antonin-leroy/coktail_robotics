from app.logparse import MetricParser, parse_big_number

LINE = ("INFO 2026-10-17 20:00:00 ot_train.py:420 step:{s} smpl:16K ep:40 epch:0.36 loss:0.512 "
        "grdn:12.345 lr:1.0e-05 updt_s:0.081 data_s:0.004 smp/s:98 mem_gb:7.21")


def test_big_numbers():
    assert parse_big_number("200") == 200
    assert parse_big_number("2K") == 2000
    assert parse_big_number("1M") == 1_000_000


def test_exact_steps_from_log_freq():
    p = MetricParser(log_freq=100)
    shown = ["100", "200", "300", "400", "500", "600", "700", "800", "900", "1K", "1K", "1K", "1K", "1K", "2K"]
    steps = [p.feed(LINE.format(s=s))[0] for s in shown]
    assert steps == list(range(100, 1600, 100))


def test_values():
    step, values = MetricParser(log_freq=200).feed(LINE.format(s="200"))
    assert step == 200
    assert values == {"epochs": 0.36, "loss": 0.512, "grad_norm": 12.345, "lr": 1e-05, "update_s": 0.081,
                      "dataloading_s": 0.004, "samples_per_s": 98.0, "gpu_mem_gb": 7.21}


def test_resume_realigns_on_printed_step():
    p = MetricParser(log_freq=100)
    assert p.feed(LINE.format(s="12K"))[0] == 12000


def test_ignores_other_lines():
    p = MetricParser(log_freq=100)
    assert p.feed("INFO Creating dataset") is None
    assert p.feed("Model pushed to https://huggingface.co/me/x") is None
