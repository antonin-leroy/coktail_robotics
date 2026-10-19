"""Catalog reads and the ratings that the storefront displays.

Ratings are not stars. A rating is the measured success rate of that skill on that
robot model, computed from the runs table -- which the robot itself writes. Nobody
types these numbers in.
"""
from __future__ import annotations

import json
import re
import math
from typing import Any

from . import db
from .models import MissingSkill, PricedStep, Step


def load_catalog() -> dict[str, dict[str, Any]]:
    return {r["id"]: json.loads(r["manifest"]) for r in db.query("SELECT id, manifest FROM skills")}


def wilson(successes: int, n: int, z: float = 1.96) -> tuple[float, float]:
    """95% Wilson score interval.

    A point estimate from 20 trials is close to meaningless on its own: 18/20 is
    "90%", but the honest claim is 90% [70%, 97%]. Wilson behaves sensibly at the
    extremes where the normal approximation falls apart (20/20 is not 100% [100%,
    100%]), which is exactly where small robot evals live.
    """
    if n <= 0:
        return (0.0, 1.0)
    phat = successes / n
    denom = 1 + z * z / n
    centre = (phat + z * z / (2 * n)) / denom
    margin = (z / denom) * math.sqrt(phat * (1 - phat) / n + z * z / (4 * n * n))
    return (max(0.0, centre - margin), min(1.0, centre + margin))


def trials_needed(target: float = 0.9, half_width: float = 0.05,
                  z: float = 1.96) -> int:
    """Trials to pin a rate near `target` to +/- `half_width`. Reality check for
    anyone planning to claim '90% success' off six runs."""
    return int(math.ceil(z * z * target * (1 - target) / (half_width * half_width)))


def success_rates(robot_model: str | None = None) -> dict[str, tuple[float, int]]:
    """{skill_id: (success_rate, n_trials)} from logged executions."""
    if robot_model:
        rows = db.query(
            """SELECT skill_id, AVG(success) AS rate, COUNT(*) AS n
               FROM runs WHERE robot_model = ? GROUP BY skill_id""",
            (robot_model,),
        )
    else:
        rows = db.query(
            "SELECT skill_id, AVG(success) AS rate, COUNT(*) AS n FROM runs GROUP BY skill_id"
        )
    return {r["skill_id"]: (float(r["rate"]), int(r["n"])) for r in rows}


def benchmark(robot_model: str | None = None) -> list[dict[str, Any]]:
    """Per-skill measured performance, with intervals and failure notes."""
    where, params = ("WHERE robot_model = ?", (robot_model,)) if robot_model else ("", ())
    rows = db.query(
        f"""SELECT skill_id, robot_model,
                   COUNT(*) AS n,
                   SUM(success) AS ok,
                   AVG(duration_s) AS mean_s,
                   MIN(created_at) AS first_run,
                   MAX(created_at) AS last_run
            FROM runs {where}
            GROUP BY skill_id, robot_model
            ORDER BY n DESC, skill_id""",
        params,
    )
    catalog = load_catalog()
    out = []
    for r in rows:
        n, ok = int(r["n"]), int(r["ok"] or 0)
        lo, hi = wilson(ok, n)
        fails = db.query(
            """SELECT notes, COUNT(*) AS c FROM runs
               WHERE skill_id = ? AND robot_model = ? AND success = 0
               GROUP BY notes ORDER BY c DESC LIMIT 3""",
            (r["skill_id"], r["robot_model"]),
        )
        skill = catalog.get(r["skill_id"], {})
        out.append({
            "skill_id": r["skill_id"],
            "name": skill.get("name", r["skill_id"]),
            "robot_model": r["robot_model"],
            "n": n,
            "successes": ok,
            "rate": round(ok / n, 4) if n else None,
            "ci_low": round(lo, 4),
            "ci_high": round(hi, 4),
            "ci_half_width": round((hi - lo) / 2, 4),
            "mean_duration_s": round(float(r["mean_s"]), 2) if r["mean_s"] else None,
            "episodes": (skill.get("dataset") or {}).get("episodes", 0),
            "dataset": (skill.get("dataset") or {}).get("id"),
            "status": skill.get("status", "unknown"),
            "first_run": r["first_run"],
            "last_run": r["last_run"],
            "top_failures": [{"note": f["notes"] or "(none)", "count": int(f["c"])}
                             for f in fails],
        })
    return out


def ratings() -> dict[str, dict[str, Any]]:
    """{skill_id: {"avg", "count"}} -- customer star ratings, for the catalog cards."""
    rows = db.query("SELECT skill_id, AVG(stars) AS avg, COUNT(*) AS n "
                    "FROM reviews GROUP BY skill_id")
    return {r["skill_id"]: {"avg": round(float(r["avg"]), 2), "count": int(r["n"])}
            for r in rows}


def rating_detail(skill_id: str, latest: int = 6) -> dict[str, Any]:
    """Average, how many of each star, and the newest reviews for one skill."""
    hist = {int(r["stars"]): int(r["n"]) for r in db.query(
        "SELECT stars, COUNT(*) AS n FROM reviews WHERE skill_id = ? GROUP BY stars",
        (skill_id,))}
    count = sum(hist.values())
    reviews = db.query(
        """SELECT stars, author, robot_model, comment, sample, created_at FROM reviews
           WHERE skill_id = ? ORDER BY created_at DESC, id DESC LIMIT ?""",
        (skill_id, latest))
    return {
        "avg": round(sum(k * v for k, v in hist.items()) / count, 2) if count else None,
        "count": count,
        "histogram": [hist.get(k, 0) for k in (5, 4, 3, 2, 1)],
        "samples": int(db.query("SELECT COUNT(*) AS n FROM reviews WHERE skill_id = ? "
                                "AND sample = 1", (skill_id,))[0]["n"]),
        "reviews": [{**dict(r), "sample": bool(r["sample"])} for r in reviews],
    }


def add_review(skill_id: str, robot_model: str, stars: int, author: str,
               comment: str) -> None:
    db.execute("INSERT INTO reviews (skill_id, robot_model, stars, author, comment) "
               "VALUES (?,?,?,?,?)", (skill_id, robot_model, stars, author, comment))


def rates_by_robot() -> dict[str, list[dict[str, Any]]]:
    """Per-skill breakdown across every robot that has run it."""
    rows = db.query(
        """SELECT skill_id, robot_model, AVG(success) AS rate, COUNT(*) AS n
           FROM runs GROUP BY skill_id, robot_model ORDER BY skill_id, robot_model"""
    )
    out: dict[str, list[dict[str, Any]]] = {}
    for r in rows:
        out.setdefault(r["skill_id"], []).append({
            "robot_model": r["robot_model"],
            "success_rate": round(float(r["rate"]), 3),
            "n_trials": int(r["n"]),
        })
    return out


_FILES: dict[str, tuple[float, Any]] = {}


def _data_file(name: str, parse, default):
    """A file under data/, parsed once per change: edits show up without a
    restart (uvicorn --reload only watches .py files)."""
    from pathlib import Path as _Path
    path = _Path(__file__).resolve().parent.parent / "data" / name
    try:
        mtime = path.stat().st_mtime
    except FileNotFoundError:
        return default
    cached = _FILES.get(name)
    if cached is None or cached[0] != mtime:
        _FILES[name] = (mtime, parse(json.loads(path.read_text())))
    return _FILES[name][1]


def datasets() -> dict[str, dict[str, Any]]:
    return _data_file("datasets.json", lambda rows: {d["id"]: d for d in rows}, {})


def object_kinds() -> dict[str, str]:
    """{kind: description} -- what the compiler may call an object. See make_catalog."""
    return _data_file("object_kinds.json", dict, {})


OPEN_ACCESS = {"open", "gated-auto", "github", "agreement"}


def open_datasets() -> dict[str, dict[str, Any]]:
    """Datasets anyone can get, by click-through at most. Private data is not a
    source a customer's gap can point at."""
    return {k: d for k, d in datasets().items() if d.get("access") in OPEN_ACCESS}


def skill_datasets(skill: dict[str, Any]) -> list[dict[str, Any]]:
    """Every known dataset for a skill: the primary one first, then the extras
    from data/skill_datasets.json. Each item is the skill's reference to it
    ({id, episodes, status|match}) plus `detail`, the datasets.json entry."""
    out, seen = [], set()
    refs = [skill.get("dataset") or {}] + list(skill.get("datasets") or [])
    for ref in refs:
        ds = datasets().get(ref.get("id") or "")
        if not ds or ds["id"] in seen:
            continue
        seen.add(ds["id"])
        out.append({**ref, "detail": ds})
    return out


def availability(skill: dict[str, Any]) -> tuple[str, dict[str, Any] | None]:
    """How ready is this skill, really?

    skill_and_data -- a trained checkpoint exists and episodes were collected
    data_only      -- no policy yet, but there is a dataset to train one from
    none           -- neither; someone has to go and record it
    """
    ds_ref = skill.get("dataset") or {}
    ds = datasets().get(ds_ref.get("id") or "")
    trained = bool(skill.get("checkpoint")) and skill.get("status") in {"trained", "beta"}
    has_data = bool(ds) and ds.get("access") in OPEN_ACCESS
    if trained and ds_ref.get("episodes"):
        return "skill_and_data", ds
    if has_data:
        return "data_only", ds
    # No primary source, but an extra open dataset covers the motion.
    extra = next((x["detail"] for x in skill_datasets(skill)
                  if x["detail"].get("access") in OPEN_ACCESS), None)
    if extra:
        return "data_only", extra
    return "none", ds


def _hands_required(skill: dict[str, Any]) -> int:
    from .validator import hands_required  # local import avoids a cycle
    return hands_required(skill)


def price_steps(
    steps: list[Step],
    catalog: dict[str, dict[str, Any]],
    rates: dict[str, tuple[float, int]],
) -> list[PricedStep]:
    """Turn plan steps into storefront line items.

    A skill is bought once: using it again later in the chain costs nothing.
    """
    priced: list[PricedStep] = []
    first_use: dict[str, int] = {}
    for i, step in enumerate(steps):
        skill = catalog.get(step.skill_id, {})
        list_price = float(skill.get("price_eur", 0.0))
        repeat_of = first_use.setdefault(step.skill_id, i)
        repeat_of = None if repeat_of == i else repeat_of
        rate, n = rates.get(step.skill_id, (None, 0))
        avail, ds = availability(skill) if skill else ("none", None)
        priced.append(PricedStep(
            skill_id=step.skill_id,
            params=step.params,
            rationale=step.rationale,
            name=skill.get("name", step.skill_id),
            title=skill.get("title", ""),
            vendor=skill.get("vendor", "unknown"),
            category=skill.get("category", ""),
            thumbnail=skill.get("thumbnail", ""),
            price_eur=0.0 if repeat_of is not None else list_price,
            list_price_eur=list_price,
            repeat_of=repeat_of,
            status=skill.get("status", "catalog"),
            success_rate=round(rate, 3) if rate is not None else None,
            n_trials=n,
            executable=bool(skill.get("checkpoint")) and skill.get("status") != "catalog",
            hand=step.hand,
            planned_hand=step.planned_hand,
            hands_required=_hands_required(skill) if skill else 0,
            availability=avail,
            dataset_name=(ds or {}).get("name", ""),
            dataset_id=(ds or {}).get("id", ""),
            dataset_count=len(skill_datasets(skill)) if skill else 0,
            preconditions=skill.get("preconditions", []),
            postconditions=skill.get("postconditions", []),
        ))
    return priced


def record_demand(prompt: str, robot_model: str, plan_id: int,
                  missing: list[MissingSkill]) -> None:
    db.execute(
        "INSERT INTO requests (prompt, robot_model, plan_id, missing_json) VALUES (?,?,?,?)",
        (prompt, robot_model, plan_id, json.dumps([m.model_dump() for m in missing])),
    )


_STOP = {"a", "an", "the", "it", "its", "to", "into", "onto", "on", "in", "of", "with",
         "and", "or", "from", "up", "down", "off", "out", "over", "at", "for", "by", "held",
         "hand", "item", "object", "thing", "surface", "container", "vessel", "substance"}


def _words(text: str) -> set[str]:
    out = set()
    for w in re.findall(r"[a-z]+", text.lower().replace("_", " ")):
        if w in _STOP:
            continue
        # crude stemming so "wiping" meets "wipe" and "drags" meets "drag",
        # without turning "press" into "pre" or "glass" into "glas"
        if w.endswith("ing") and len(w) > 5:
            w = w[:-3]
        elif w.endswith("ed") and len(w) > 4:
            w = w[:-2]
        elif w.endswith(("ses", "xes", "zes", "ches", "shes")):
            w = w[:-2]
        elif w.endswith("s") and not w.endswith("ss") and len(w) > 3:
            w = w[:-1]
        out.add(w)
    return out


def _first_word(phrase: str) -> str | None:
    """The stemmed first content word of an alias -- its verb, by convention."""
    for w in phrase.lower().replace("_", " ").split():
        got = _words(w)
        if got:
            return got.pop()
    return None


def covering_skill(gap: dict[str, Any], catalog: dict[str, dict[str, Any]]) -> dict[str, Any] | None:
    """The catalog skill a proposed gap restates, if any, judged by its aliases.

    A gap matches when the content words of one alias (or of the skill's id) all
    appear in the gap's id, name and description. "drag_over_surface -- Drag the
    cloth over the table" contains {drag, cloth} from wipe_surface's alias "drag
    the cloth over", so it is not a gap. Matching is on motion words only; the
    stop list keeps "the item into the container" from matching everything.
    """
    # A one-word alias ("hold", "take") is too common to match on a description
    # -- "peel the banana while holding it" is not a grasp -- so single words
    # must appear in the gap's own id or name; longer phrases may match anywhere.
    generic = {"press", "push", "pick", "take", "grab", "hold", "lift", "place", "put",
               "set", "drop", "leave", "move", "carry", "bring", "turn", "open", "close",
               "add", "remove", "fill", "empty", "check", "find", "look", "release"}
    head = _words(f"{gap.get('proposed_id', '')} {gap.get('name', '')}")
    have = head | _words(str(gap.get("description", "")))
    best: tuple[int, dict[str, Any]] | None = None
    for sid in sorted(catalog):
        s = catalog[sid]
        if s.get("category") == "composite":
            continue
        for phrase in list(s.get("aliases", [])) + [sid]:
            need = _words(phrase)
            if not need:
                continue
            if len(need) == 1 and need & generic:
                continue                    # "press", "take": says nothing on its own
            # The phrase's verb (its first content word) must be in the gap's own
            # name: "water the plant" is not what "locate the next plant pot to
            # water" asks for, even though every word is in the description.
            verb = _first_word(phrase)
            pool = head if len(need) == 1 else have
            if need <= pool and (verb is None or verb in head) and \
                    (best is None or len(need) > best[0]):
                best = (len(need), s)
    if best is None:
        return None
    s = best[1]
    return {"id": s["id"], "name": s["name"], "status": s.get("status", "catalog"),
            "trained": bool(s.get("checkpoint")) and s.get("status") != "catalog"}


def gap_report(limit: int = 20) -> dict[str, Any]:
    """Unmet demand, aggregated. This is the data-collection roadmap."""
    rows = db.query("SELECT prompt, robot_model, missing_json, created_at FROM requests")
    tally: dict[str, dict[str, Any]] = {}
    for r in rows:
        for m in json.loads(r["missing_json"]):
            key = m["proposed_id"]
            entry = tally.setdefault(key, {
                "proposed_id": key,
                "name": m.get("name", key),
                "description": m.get("description", ""),
                "requests": 0,
                "example_prompts": [],
            })
            entry["requests"] += 1
            if len(entry["example_prompts"]) < 3 and r["prompt"] not in entry["example_prompts"]:
                entry["example_prompts"].append(r["prompt"])

    # Gaps the catalog already covers stay in the list -- they are still demand
    # -- but say which skill answers them, so a binder miss is not mistaken for a
    # new skill to record.
    catalog = load_catalog()
    for entry in tally.values():
        entry["covered_by"] = covering_skill(entry, catalog)

    ranked = sorted(tally.values(), key=lambda e: -e["requests"])[:limit]
    return {
        "total_requests": len(rows),
        "distinct_gaps": len(tally),
        "covered_gaps": sum(1 for e in tally.values() if e["covered_by"]),
        "gaps": ranked,
    }
