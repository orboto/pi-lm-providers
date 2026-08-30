#!/usr/bin/env python3
"""Generate the gallery screenshot HTML with programmatically aligned columns.

Render the PNG afterwards (macOS, Chrome at the default path):

    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
        --headless --disable-gpu --hide-scrollbars --force-device-scale-factor=2 \
        --window-size=1040,540 --screenshot=docs/screenshot.png \
        "file://$(pwd)/docs/page.html"
"""
import html

rows = [
    ("ollama",    "deepseek-v4-pro:0813",           "1.0M",   "65.5K", "yes", "no"),
    ("ollama",    "gpt-oss:120b",                   "131.1K", "65.5K", "yes", "no"),
    ("ollama",    "glm-5.2",                        "1.0M",   "65.5K", "yes", "no"),
    ("ollama",    "qwen3.5:397b",                   "262.1K", "65.5K", "yes", "yes"),
    ("lmstudio",  "google/gemma-4-26b-a4b",         "262.1K", "65.5K", "yes", "yes"),
    ("lmstudio",  "mistralai/devstral-small-2-2512","393.2K", "65.5K", "no",  "yes"),
    ("lmstudio",  "openai/gpt-oss-20b",             "131.1K", "65.5K", "yes", "no"),
    ("lmstudio",  "qwen/qwen3-coder-30b",           "262.1K", "65.5K", "no",  "no"),
]

headers = ("provider", "model", "context", "max-out", "thinking", "images")
widths = [max(len(headers[i]), max(len(r[i]) for r in rows)) + 2 for i in range(6)]

def line(cells):
    return "".join(c + " " * (w - len(c)) for c, w in zip(cells, widths)).rstrip()

header_line = line(headers)
data_lines = []
for prov, model, ctx, out, think, img in rows:
    data_lines.append((prov, line((prov, model, ctx, out, think, img))))

span = {
    "ollama": 'prov-ollama', "lmstudio": 'prov-lmstudio',
}
body_lines = []
body_lines.append('<span class="prompt">$</span> <span class="cmd">pi --list-models</span>')
header_html = html.escape(header_line)
body_lines.append(f'<span class="hdr">{header_html}</span>')
for prov, text in data_lines:
    esc = html.escape(text)
    # colorize the trailing yes/no columns
    for val, cls in (("yes", "yes"), ("no", "no")):
        if text.rstrip().endswith(val):
            idx = esc.rfind(val)
            esc = esc[:idx] + f'<span class="{cls}">{val}</span>'
            break
    # colorize context/max-out numbers (2nd and 3rd last columns)
    cls = span[prov]
    # escape model name portion in white
    body_lines.append(f'<span class="{cls}">{prov}</span><span class="m">{html.escape(text[len(prov):])}</span>')
body_lines.append('<span class="footnote"># ollama: local server + Ollama Cloud (https://ollama.com) — /login ollama</span>')
body_lines.append('<span class="footnote"># lmstudio: LM Studio developer server (incl. LM Studio Bionic) — no login needed</span>')

page = """<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
	* { margin: 0; padding: 0; box-sizing: border-box; }
	body { background: transparent; }
	.terminal {
		width: 980px;
		background: #1e1e2e;
		border-radius: 12px;
		box-shadow: 0 20px 60px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.08);
		overflow: hidden;
		font-family: "SF Mono", Menlo, Monaco, "Cascadia Code", monospace;
		font-size: 14px;
		line-height: 1.65;
	}
	.titlebar { display: flex; align-items: center; gap: 8px; padding: 11px 14px;
		background: #181825; border-bottom: 1px solid rgba(255,255,255,0.06); }
	.dot { width: 12px; height: 12px; border-radius: 50%; }
	.red { background: #f38ba8; } .yellow { background: #f9e2af; } .green { background: #a6e3a1; }
	.title { flex: 1; text-align: center; color: #a6adc8; font-size: 13px; margin-right: 56px; }
	.body { padding: 18px 22px 22px; color: #cdd6f4; white-space: pre; }
	.prompt { color: #a6e3a1; font-weight: bold; }
	.cmd { color: #cdd6f4; font-weight: bold; }
	.hdr { color: #89b4fa; font-weight: bold; }
	.prov-ollama { color: #fab387; font-weight: bold; }
	.prov-lmstudio { color: #89dceb; font-weight: bold; }
	.m { color: #f5e0dc; }
	.yes { color: #a6e3a1; } .no { color: #585b70; }
	.footnote { color: #6c7086; }
</style></head>
<body>
<div class="terminal">
	<div class="titlebar">
		<div class="dot red"></div><div class="dot yellow"></div><div class="dot green"></div>
		<div class="title">pi — model catalog</div>
	</div>
	<div class="body">""" + "\n".join(body_lines) + """</div>
</div>
</body></html>
"""
import pathlib; out = pathlib.Path(__file__).parent / "page.html"; out.write_text(page)
print(f"HTML written to {out}")
print(header_line)
for _, t in data_lines:
    print(t)
