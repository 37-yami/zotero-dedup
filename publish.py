#!/usr/bin/env python3
"""Publish Zotero Dedup v0.1.1 without git transport (github.com:443 blocked).

Pushes the changed files via the GitHub Git Database API, creates an
annotated tag, then creates the GitHub Release and uploads the xpi asset.

Usage:
    GITHUB_TOKEN=ghp_xxx python3 publish.py

Requires only Python 3 + network to api.github.com / uploads.github.com.
"""
import os
import sys
import json
import base64
import urllib.request
import urllib.error
from datetime import datetime, timezone

REPO = "37-yami/zotero-dedup"
TAG = "v0.1.1"
XPI = "build/zotero-dedup.xpi"
API = "https://api.github.com"
UPLOAD = "https://uploads.github.com"
BASE_REF = "75edbd7"  # last commit already on origin/master

# files changed since BASE_REF (path relative to repo root)
CHANGED = [
    "CHANGELOG.md",
    "addon/bootstrap.js",
    "addon/manifest.json",
    "release.py",
    "update.json",
]


def api(method, url, token, data=None, host=API, is_upload=False):
    headers = {
        "Authorization": "Bearer " + token,
        "Accept": "application/vnd.github+json",
        "User-Agent": "zotero-dedup-publish",
    }
    if data is not None:
        if is_upload:
            headers["Content-Type"] = "application/octet-stream"
            body = data
        else:
            headers["Content-Type"] = "application/json"
            body = json.dumps(data).encode("utf-8")
    else:
        body = None
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        sys.exit("HTTPError %s: %s" % (e.code, e.read().decode("utf-8", "replace")))


def get_json(method, url, token, data=None, host=API):
    status, raw = api(method, url, token, data=data, host=host)
    return status, json.loads(raw) if raw else {}


def main():
    token = os.environ.get("GITHUB_TOKEN")
    if not token:
        sys.exit("Set GITHUB_TOKEN first.")

    print("[1/8] get base ref")
    _, ref = get_json("GET", f"{API}/repos/{REPO}/git/refs/heads/master", token)
    base_sha = ref["object"]["sha"]
    print("      base commit:", base_sha)

    print("[2/8] get base tree")
    _, commit = get_json("GET", f"{API}/repos/{REPO}/git/commits/{base_sha}", token)
    base_tree = commit["tree"]["sha"]

    print("[3/8] create blobs for changed files")
    tree_entries = []
    for path in CHANGED:
        with open(path, "rb") as f:
            content = base64.b64encode(f.read()).decode("ascii")
        _, blob = get_json(
            "POST", f"{API}/repos/{REPO}/git/blobs", token,
            data={"content": content, "encoding": "base64"},
        )
        tree_entries.append({"path": path, "mode": "100644", "type": "blob", "sha": blob["sha"]})
        print("      blob:", path, "->", blob["sha"][:10])

    print("[4/8] create tree")
    _, tree = get_json(
        "POST", f"{API}/repos/{REPO}/git/trees", token,
        data={"base_tree": base_tree, "tree": tree_entries},
    )
    new_tree = tree["sha"]

    print("[5/8] create commit")
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    _, new_commit = get_json(
        "POST", f"{API}/repos/{REPO}/git/commits", token,
        data={
            "message": "bump to v0.1.1 (detect fix + diagnostics)",
            "tree": new_tree,
            "parents": [base_sha],
            "author": {"name": "Zotero Dedup", "email": "noreply@github.com", "date": now},
            "committer": {"name": "Zotero Dedup", "email": "noreply@github.com", "date": now},
        },
    )
    new_commit_sha = new_commit["sha"]
    print("      new commit:", new_commit_sha)

    print("[6/8] update master ref")
    get_json("PATCH", f"{API}/repos/{REPO}/git/refs/heads/master", token, data={"sha": new_commit_sha, "force": False})
    print("      master updated")

    print("[7/8] create annotated tag " + TAG)
    _, tag_obj = get_json(
        "POST", f"{API}/repos/{REPO}/git/tags", token,
        data={
            "tag": TAG,
            "message": "Zotero Dedup v0.1.1",
            "object": new_commit_sha,
            "type": "commit",
            "tagger": {"name": "Zotero Dedup", "email": "noreply@github.com", "date": now},
        },
    )
    get_json("POST", f"{API}/repos/{REPO}/git/refs", token,
             data={"ref": "refs/tags/" + TAG, "sha": tag_obj["sha"]})
    print("      tag created")

    print("[8/8] create release + upload asset")
    body = (
        "Zotero Dedup v0.1.1\n\n"
        "- 修复查重检测过严导致无法识别重复文章的问题（多候选键 + 并查集宽松匹配）。\n"
        "- 增加扫描诊断日志与「未发现重复」提示中的条目计数。\n"
        "- 支持 Zotero 7 / 8 / 9。"
    )
    _, rel = get_json(
        "POST", f"{API}/repos/{REPO}/releases", token,
        data={"tag_name": TAG, "name": TAG, "body": body, "draft": False, "prerelease": False},
    )
    upload_url = rel["upload_url"].split("{")[0]
    with open(XPI, "rb") as f:
        data = f.read()
    status, _ = api(
        "POST", f"{upload_url}?name=zotero-dedup.xpi&label=zotero-dedup.xpi",
        token, data=data, host=UPLOAD, is_upload=True,
    )
    print("      release:", rel.get("html_url"))
    print("      asset upload HTTP", status)
    print("DONE. https://github.com/%s/releases/tag/%s" % (REPO, TAG))


if __name__ == "__main__":
    main()
