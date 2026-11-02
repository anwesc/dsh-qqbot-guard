# -*- coding: utf-8 -*-
"""Update the GitHub repo description without ever printing the token."""
import json
import subprocess
import sys
import urllib.request

REPO = "anwesc/dsh-qqbot-guard"
DESCRIPTION = "DSH 插件：QQ 群关键词唤醒 + 群历史附件 + 设置页可视化配置（qqbot-guard）"


def token():
    """Read the stored GitHub credential from git's credential helper."""
    out = subprocess.run(
        ["git", "credential", "fill"],
        input="protocol=https\nhost=github.com\n\n",
        capture_output=True,
        text=True,
        cwd=".",
        check=True,
    ).stdout
    for line in out.splitlines():
        if line.startswith("password="):
            return line[len("password="):]
    raise SystemExit("no password in credential output")


def api(method, path, payload):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        "https://api.github.com" + path, data=body, method=method)
    request.add_header("Authorization", "Bearer " + token())
    request.add_header("Accept", "application/vnd.github+json")
    request.add_header("Content-Type", "application/json; charset=utf-8")
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.loads(response.read().decode("utf-8"))


if __name__ == "__main__":
    updated = api("PATCH", "/repos/" + REPO, {"description": DESCRIPTION})
    print("status ok")
    print("description:", updated.get("description"))
    print("topics:", updated.get("topics"))
