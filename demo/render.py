"""Render the pubready narrated demo: real command output + edge-tts narration.

Usage: python demo/render.py [scene numbers]   (needs ffmpeg, edge-tts, Pillow, gh, network)
The demo repo is built by demo/make-demo-repo.sh into DEMO (a broken release setup for "pubready" itself).
"""
import asyncio
import os
import re
import subprocess
import sys

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
BUILD = os.path.join(HERE, "build")
OUT = os.path.join(ROOT, "demo.mp4")
SDKBIN = os.environ.get("PUBREADY_BIN", "/tmp/pubbin")
DEMO = os.environ.get("PUBREADY_DEMO", "/tmp/pubdemo")
W, H, FPS = 1280, 720, 24
VOICE = "en-US-AndrewNeural"
MONO = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"
MONO_B = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf"
SANS_B = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
SANS = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
BG, FG = (24, 26, 33), (220, 223, 228)
ANSI = {"31": (255, 95, 95), "32": (95, 215, 120), "33": (240, 200, 80),
        "2": (130, 135, 145), "36": (90, 200, 230), "35": (200, 140, 230), "1": FG}
PROMPT = "dev@laptop ~/pubready $ "
RUN_URL = "https://github.com/meilisearch/strapi-plugin-meilisearch/actions/runs/34307137670"

SCENES = [
    {
        "kind": "title",
        "title": "pubready",
        "sub": "preflight for npm trusted publishing\nfind out why npm publish will fail, before you tag",
        "say": ("This is pub ready, a small open source preflight for npm trusted publishing. It reads your release "
                "workflow and package dot json, and tells you why npm publish is going to fail, before you push the tag."),
    },
    {
        "kind": "bullets",
        "title": "The problem",
        "bullets": [
            "npm killed classic tokens; trusted publishing (OIDC) is the way now",
            "Half a dozen exact-match rules, and npm doesn't check the form",
            "Almost every mistake comes back as  404 Not Found - PUT",
            "npm/cli#8730: 30 comments, a different cause for each person",
            "   Node 22's npm 10, letter case, reusable workflows, old tokens...",
            "Releases tagged that never reached npm, every week",
        ],
        "say": ("npm revoked classic tokens, so everyone is moving to trusted publishing. It has half a dozen exact match "
                "rules, npm doesn't validate the settings when you save them, and nearly every mistake comes back as the "
                "same four oh four not found. One npm C L I issue has thirty comments, each person finding a different cause."),
    },
    {
        "kind": "term",
        "cmds": ["cat .github/workflows/publish.yml"],
        "say": ("Say I want to publish pub ready itself to npm. Here's a typical release setup: C I calls this reusable "
                "publish workflow on a tag, with Node 22, and the old N P M token still wired in. Looks fine."),
    },
    {
        "kind": "term",
        "scroll": True,
        "cmds": ["pubready"],
        "say": ("Run pub ready in the repo. It finds the publish step, follows npm run release to npm publish, and "
                "reports five errors. The calling workflow and the publish job don't grant the I D token permission. "
                "Node 22 ships npm ten, which can't do O I D C. The package isn't on npm yet, and the first publish "
                "has to be manual. And the repository U R L has the wrong letter case, which npm rejects with a four "
                "twenty two. Each one comes with the fix. At the bottom: the exact values for the npm settings form, "
                "and note the workflow file name is C I dot yml, the caller, not publish dot yml."),
    },
    {
        "kind": "term",
        "scroll": True,
        "reveal": 0.5,
        "cmds": ["git apply ../pubdemo-fix.patch && git diff --stat", "pubready | tail -n 22"],
        "show": ["git apply fix.patch && git diff --stat", "pubready | tail -n 22"],
        "say": ("I apply those fixes and run it again. What's left is the one thing no workflow change can fix: "
                "publish the first version by hand, then add the trusted publisher with these values, and finish a C I "
                "publish within two days, or the config expires."),
    },
    {
        "kind": "term",
        "scroll": True,
        "reveal": 0.6,
        "cmds": ["pubready explain " + RUN_URL],
        "show": ["pubready explain https://github.com/meilisearch/strapi-plugin-meilisearch/actions/runs/34307137670"],
        "say": ("Already have a red run? pub ready explain takes the run U R L, pulls the failed log with the GitHub "
                "C L I, and maps it to a cause. This is a real failure from this month: a four oh four on publish, and "
                "the log shows npm ten point eight, so the O I D C exchange never happened."),
    },
    {
        "kind": "bullets",
        "title": "In CI, before the release",
        "bullets": [
            "uses: hamarshehmhmd/pubready@v0.1.0",
            "   annotations on the exact workflow / package.json line",
            "GitHub Actions + GitLab CI, monorepos, changesets, lerna, pnpm",
            "--format json  ·  --strict  ·  --offline",
            "Online: GitHub's canonical repo name, does the package exist,",
            "   is this version already taken",
        ],
        "say": ("Put it in a pull request check with the GitHub action, and the problem shows up as an annotation on "
                "the line instead of a failed release. It handles GitLab too, monorepos, changesets, lerna and p n p m, "
                "and the online checks ask GitHub for the canonical repo name and npm whether the package and version exist."),
    },
    {
        "kind": "bullets",
        "title": "Try it",
        "bullets": [
            "npx github:hamarshehmhmd/pubready",
            "npx github:hamarshehmhmd/pubready explain <run URL>",
            "github.com/hamarshehmhmd/pubready",
            "GNU AGPL-3.0-or-later (commercial licenses available)",
        ],
        "say": ("Run it with one n p x line, no install. pub ready is licensed under the GNU Affero General Public "
                "License, version three or later, with commercial licenses available from the author."),
    },
]


async def tts(text, path):
    import edge_tts
    for attempt in range(8):
        try:
            await edge_tts.Communicate(text, VOICE, rate="+4%").save(path)
            return
        except Exception:
            if os.path.exists(path):
                os.remove(path)
            if attempt == 7:
                raise
            await asyncio.sleep(5)


def duration(path):
    out = subprocess.check_output(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
        text=True,
    )
    return float(out.strip())


EXPORTS = {}


def run_cmd(cmd, cwd):
    if cmd.startswith("export ") and "=" in cmd:
        k, v = cmd[7:].split("=", 1)
        EXPORTS[k] = v
        return ""
    env = dict(os.environ, FORCE_COLOR="1", **EXPORTS)
    env.pop("NO_COLOR", None)
    env["PATH"] = os.pathsep.join([SDKBIN, env["PATH"]])
    env["COLUMNS"] = "120"
    p = subprocess.run(
        ["bash", "-c", "shopt -s nullglob; " + cmd],
        cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=env,
    )
    return p.stdout.rstrip("\n")


def parse_ansi(line):
    spans, color, bold = [], FG, False
    for part in re.split(r"(\x1b\[[0-9;]*m)", line):
        m = re.match(r"\x1b\[([0-9;]*)m", part)
        if m:
            for code in (m.group(1) or "0").split(";"):
                if code == "0":
                    color, bold = FG, False
                elif code == "1":
                    bold = True
                elif code in ANSI:
                    color = ANSI[code]
        elif part:
            spans.append((part, color, bold))
    return spans


class Term:
    def __init__(self):
        self.font = ImageFont.truetype(MONO, 14)
        self.bold = ImageFont.truetype(MONO_B, 14)
        self.cw = self.font.getlength("M")
        self.lh = 20
        self.cols = int((W - 80) / self.cw)

    def wrap(self, spans):
        lines, cur, n = [], [], 0
        for text, c, b in spans:
            while text:
                room = self.cols - n
                if room <= 4:
                    lines.append(cur); cur, n = [], 0
                    text = "    " + text.lstrip(" ")
                    room = self.cols
                if len(text) <= room:
                    cur.append((text, c, b)); n += len(text); text = ""
                else:
                    cut = text.rfind(" ", 0, room + 1)
                    cut = cut if cut > 4 else room
                    cur.append((text[:cut], c, b)); lines.append(cur); cur, n = [], 0
                    text = "    " + text[cut:].lstrip(" ")
        lines.append(cur)
        return lines

    def frame(self, lines, cursor=False):
        img = Image.new("RGB", (W, H), BG)
        d = ImageDraw.Draw(img)
        d.rounded_rectangle([20, 14, W - 20, H - 14], 12, fill=(30, 33, 41), outline=(60, 64, 76))
        for i, c in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
            d.ellipse([40 + i * 24, 30, 54 + i * 24, 44], fill=c)
        d.text((W // 2, 37), "~/pubready — bash", font=ImageFont.truetype(SANS, 15), fill=(150, 155, 165), anchor="mm")
        visible = lines[-30:]
        y = 64
        for ln in visible:
            x = 40
            for text, c, b in ln:
                d.text((x, y), text, font=self.bold if b else self.font, fill=c)
                x += self.cw * len(text)
            y += self.lh
        if cursor:
            last = visible[-1] if visible else []
            x = 40 + self.cw * sum(len(t) for t, _, _ in last)
            d.rectangle([x, y - self.lh + 3, x + self.cw - 2, y - 4], fill=FG)
        return img


def card(scene):
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    if scene["kind"] == "title":
        d.text((W // 2, 280), scene["title"], font=ImageFont.truetype(MONO_B, 78), fill=(95, 215, 120), anchor="mm")
        d.multiline_text((W // 2, 420), scene["sub"], font=ImageFont.truetype(SANS, 32), fill=FG, anchor="mm",
                         align="center", spacing=12)
        d.text((W // 2, 620), "github.com/hamarshehmhmd/pubready  ·  check · explain · GitHub Action  ·  GNU AGPL-3.0",
               font=ImageFont.truetype(SANS, 20), fill=(150, 155, 165), anchor="mm")
    else:
        d.text((90, 90), scene["title"], font=ImageFont.truetype(SANS_B, 52), fill=(95, 215, 120))
        f = ImageFont.truetype(SANS, 29)
        y = 200
        for b in scene["bullets"]:
            if b and not b.startswith("   "):
                d.text((90, y), "•", font=f, fill=(240, 200, 80))
            d.text((130, y), b.strip(), font=f, fill=FG)
            y += 58 if b.startswith("   ") or not b else 62
    return img


class Writer:
    def __init__(self, path, audio):
        self.p = subprocess.Popen(
            ["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24",
             "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-", "-i", audio,
             "-af", "apad", "-c:v", "libx264", "-preset", "medium", "-crf", "23",
             "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-ar", "44100",
             "-shortest", path],
            stdin=subprocess.PIPE,
        )
        self.n = 0

    def put(self, img, count=1):
        data = img.tobytes()
        for _ in range(count):
            self.p.stdin.write(data)
        self.n += count

    def close(self):
        self.p.stdin.close()
        self.p.wait()
        if self.p.returncode:
            sys.exit("ffmpeg failed")


def _cap_output(out, tail=False):
    lines = out.splitlines()
    if tail and len(lines) > 26:
        return "\n".join(["…"] + lines[-25:])
    if len(lines) > 24:
        lines = lines[:22] + ["…", lines[-1]]
    return "\n".join(lines)


def render_scene(i, scene, workdir):
    audio = os.path.join(BUILD, f"s{i}.mp3")
    if not os.path.exists(audio):
        asyncio.run(tts(scene["say"], audio))
    total = int((duration(audio) + 0.7) * FPS)
    path = os.path.join(BUILD, f"s{i}.mp4")
    w = Writer(path, audio)
    if scene["kind"] != "term":
        w.put(card(scene), total)
        w.close()
        return path
    t = Term()
    shown = scene.get("show", scene["cmds"])
    wd = workdir
    outputs = [run_cmd(c, wd) if scene.get("scroll") else _cap_output(run_cmd(c, wd), scene.get("tail")) for c in scene["cmds"]]
    # If show has more lines than cmds (a command displayed as several visual lines
    # that map to one executed command), join show into one typed command per output.
    if len(shown) != len(outputs):
        if len(outputs) == 1:
            shown = [" ".join(s.rstrip("\\").strip() for s in shown)]
        elif len(shown) > len(outputs):
            # first N-1 outputs map 1:1; remaining show lines are the last command
            shown = list(shown[: len(outputs) - 1]) + [
                " ".join(s.rstrip("\\").strip() for s in shown[len(outputs) - 1 :])
            ]
    steps = list(zip(shown, outputs))
    typing = sum(len(s) for s, _ in steps) / 32 * FPS
    pause = max(6, int((total - typing) / max(1, len(steps))) - 4)
    lines = []
    for cmd, out in steps:
        prompt = [(scene.get("prompt", PROMPT), (95, 215, 120), True)]
        for k in range(0, len(cmd) + 1, 2):
            frame = t.frame(lines + t.wrap(prompt + [(cmd[:k], FG, False)]), cursor=True)
            w.put(frame)
        lines += t.wrap(prompt + [(cmd, FG, False)])
        outl = []
        for ol in out.splitlines():
            outl += t.wrap(parse_ansi(ol))
        hold = min(pause, max(0, total - w.n))
        if scene.get("scroll") and len(outl) > 28:
            # reveal the output gradually so the narration can walk through it
            reveal = int(hold * scene.get("reveal", 0.8))
            for f in range(reveal):
                k = 28 + int((len(outl) - 28) * (f + 1) / reveal)
                w.put(t.frame(lines + outl[:k]))
            hold -= reveal
        lines += outl
        lines.append([])
        w.put(t.frame(lines), max(0, hold))
    final = t.frame(lines + t.wrap([(scene.get("prompt", PROMPT), (95, 215, 120), True)]), cursor=True)
    if w.n < total:
        w.put(final, total - w.n)
    w.close()
    return path






def setup():
    subprocess.run(["bash", os.path.join(HERE, "make-demo-repo.sh"), DEMO], check=True)


def main():
    os.makedirs(BUILD, exist_ok=True)
    setup()
    only = [int(x) for x in sys.argv[1:]]
    parts = []
    for i, s in enumerate(SCENES):
        if not only or i in only:
            parts.append(render_scene(i, s, DEMO))
        else:
            parts.append(os.path.join(BUILD, "s%d.mp4" % i))
    with open(os.path.join(BUILD, "list.txt"), "w") as fh:
        fh.writelines(f"file '{p}'\n" for p in parts)
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i",
         os.path.join(BUILD, "list.txt"), "-c:v", "libx264", "-crf", "23", "-pix_fmt", "yuv420p",
         "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", OUT],
        check=True,
    )
    with open(os.path.join(BUILD, "narration.txt"), "w") as fh:
        fh.write("\n\n".join(s["say"] for s in SCENES) + "\n")
    print(OUT, round(duration(OUT), 1), "s")


if __name__ == "__main__":
    main()
