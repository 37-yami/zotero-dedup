#!/usr/bin/env python3
"""Publish Zotero Dedup v0.1.1 to GitHub.

Usage:
    GITHUB_TOKEN=ghp_xxx python3 release.py

What it does:
  1. git push origin master  (commit with the new xpi + versions)
  2. git push origin v0.1.1  (the annotated tag)
  3. Create GitHub Release v0.1.1 (via REST API)
  4. Upload build/zotero-dedup.xpi as a release asset

Requires Python 3 and network access to github.com / api.github.com.
The token needs `repo` (or `public_repo`) scope.
"""
import os
import sys
import json
import base64
import subprocess
import urllib.request
import urllib.error

REPO = "37-yami/zotero-dedup"
TAG = "v0.1.1"
XPI = "build/zotero-dedup.xpi"
API = "https://api.github.com"


def run(cmd, display=None):
    print("+ " + (display if display is not None else " ".join(cmd)))
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        print(r.stdout)
        print(r.stderr, file=sys.stderr)
        sys.exit("Command failed: " + (display if display is not None else " ".join(cmd)))
    return r.stdout


def api_request(method, url, token, data=None, is_upload=False):
    headers = {
        "Authorization": "Bearer " + token,
        "Accept": "application/vnd.github+json",
        "User-Agent": "zotero-dedup-release",
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
            raw = resp.read()
            return resp, raw
    except urllib.error.HTTPError as e:
        print("HTTPError", e.code, e.read().decode("utf-8", "replace"), file=sys.stderr)
        raise


def main():
    token = os.environ.get("GITHUB_TOKEN")
    if not token:
        sys.exit("Set GITHUB_TOKEN first: GITHUB_TOKEN=ghp_xxx python3 release.py")

    # 1. push commit + tag (authenticate the push with the token)
    auth_url = f"https://{token}@github.com/{REPO}.git"
    run(["git", "push", auth_url, "master"], display="git push origin master")
    run(["git", "push", auth_url, TAG], display="git push origin " + TAG)

    # 2. create release
    body = (
        "Zotero Dedup v0.1.1\n\n"
        "- 修复查重检测过严导致无法识别重复文章的问题（多候选键 + 并查集宽松匹配）。\n"
        "- 增加扫描诊断日志与「未发现重复」提示中的条目计数。\n"
        "- 支持 Zotero 7 / 8 / 9。"
    )
    resp, raw = api_request(
        "POST",
        f"{API}/repos/{REPO}/releases",
        token,
        data={
            "tag_name": TAG,
            "name": TAG,
            "body": body,
            "draft": False,
            "prerelease": False,
        },
    )
    rel = json.loads(raw)
    upload_url = rel["upload_url"].split("{")[0]
    print("Release created:", rel.get("html_url"))

    # 3. upload asset
    with open(XPI, "rb") as f:
        data = f.read()
    resp, _ = api_request(
        "POST",
        f"{upload_url}?name=zotero-dedup.xpi&label=zotero-dedup.xpi",
        token,
        data=data,
        is_upload=True,
    )
    print("Asset uploaded (HTTP", resp.status, ").")
    print("Done. View at https://github.com/%s/releases/tag/%s" % (REPO, TAG))


if __name__ == "__main__":
    main()
