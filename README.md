# Paper Buddy for Zotero

Ask an AI model about the passages you highlight in Zotero's PDF reader. Select some text, type your question, and the answer appears in a side panel next to the paper. Every question and answer is also saved in a note on the paper, so it syncs and can be exported, for example to Obsidian.

It works with Claude (Anthropic API) and with any OpenAI-compatible API, such as GWDG SAIA or a local Ollama. You bring your own API key.

Supports Zotero 7 to 10.

> This is a community plugin. It is not made or endorsed by Anthropic or the Zotero project.

## Features

- **Ask from the selection popup.** Select text, type a question into the **Ask Claude…** box and press Enter. The passage is highlighted in your question color with the question as its comment.
- **Answers in the reader sidebar.** Each question becomes a thread with the answer, follow-up questions, Show in PDF, Copy and Ask again.
- **Figures and tables.** Draw an image annotation around a figure, write your question as the comment, and the model sees the image itself.
- **Whole-paper context.** The paper's full text goes along with each question. With Claude it is prompt-cached, so follow-up questions on the same paper cost much less.
- **Notes.** All Q&A on a paper is mirrored into a "Claude Q&A" child note.

## Installation

1. Download the latest `.xpi` file from [Releases](https://github.com/GronuJ/zotero-paper-buddy/releases/latest). In Firefox, right-click the link and choose **Save Link As…**. Otherwise Firefox tries to install it as a Firefox add-on.
2. In Zotero, open **Tools › Plugins**.
3. Click the gear icon, choose **Install Plugin From File…** and select the `.xpi`.

Zotero checks for new versions about once a day and installs them automatically. To check right away, use **Tools › Plugins › gear icon › Check for Updates**.

## Setup

Open **Zotero › Settings › Claude** (on Windows and Linux, **Edit › Settings › Claude**).

### With Claude (Anthropic)

1. Create an API key in the [Anthropic Console](https://console.anthropic.com/settings/keys).
2. Choose **Anthropic** as the provider, paste the key and click **Save key**, then **Test**.
3. The default model is `claude-opus-5-5`. You can type any other model ID.

### With GWDG SAIA or another OpenAI-compatible API

1. Get an API key. For SAIA, follow the [GWDG docs](https://docs.hpc.gwdg.de/services/ai-services/saia/index.html).
2. Choose **OpenAI-compatible** as the provider.
3. Set the base URL. For SAIA that is `https://chat-ai.academiccloud.de/v1`. For a local Ollama it is `http://localhost:11434/v1`.
4. Enter a model name, paste the key, click **Save key**, then **Test**.

Figure questions need a model that accepts images.

### Other settings

| Setting | Default | What it does |
|---|---|---|
| Question color | Magenta | Highlights in this color with a comment count as questions |
| Answer length | Short | Short (2-4 sentences), Medium or Detailed |
| Effort | High | How hard Claude thinks before answering (Anthropic only) |
| Send questions automatically | Off | Sends a commented highlight a few seconds after you stop typing, without pressing Ask |
| Send the whole paper as context | On | Includes the paper's full text as context |
| Save answers in a "Claude Q&A" note | On | Keeps the "Claude Q&A" child note up to date |
| Instructions for the model | Empty | Your own system prompt. Leave empty for the defaults |

API keys are stored in Zotero's password manager, with a separate key for each provider.

## Usage

**Ask about text.** Select a passage. In the popup, type your question into **Ask Claude…** and press Enter. The answer appears in the **Claude** section of the right-hand pane. Click the sparkle icon in the sidebar to jump to it.

**Ask about a figure or table.** Use Zotero's image annotation tool to draw a box in your question color, write the question as the comment, then click **Ask** in the Claude panel.

**Other ways to ask.** Highlights you make in the question color and comment on appear in the panel as "Not asked yet", with **Ask** and **Ask all** buttons. You can also right-click any annotation and choose **Ask Claude**.

**Follow-ups.** Type a follow-up under any answer, or use **Ask again** to start the thread over.

### Importing into Obsidian

The Q&A lives in the "Claude Q&A" child note, so any importer that brings in child notes picks it up. With the [Zotero Integration](https://github.com/mgmeyers/obsidian-zotero-integration) plugin, add this to your import template:

```
{% for note in notes %}{% if "Claude Q&A" in note.note %}
## Questions to Claude
{{note.note}}
{% endif %}{% endfor %}
```

## Privacy

When you ask a question, the plugin sends your question, the highlighted text, the paper's title, authors and year, and (if enabled) the paper's full text to the provider you configured. Figure questions also send the image. Nothing is sent anywhere else, and nothing is sent until you ask.

## Known limitations

- Editing a comment after it has been answered doesn't send it again. Use **Ask again**.
- Threads are stored on the computer where they were asked, in `claude-paper-buddy.json` in your Zotero data folder. The note syncs through Zotero, but the panel on another computer won't show those threads.
- The "Claude Q&A" note is regenerated from the threads, so edits you make to it are overwritten.
- For OpenAI-compatible models, the paper text is cut to about 48,000 characters around the highlight. You can change this with the hidden pref `extensions.claudepaperbuddy.maxContextChars`.
- If you use Ethereal Style's color names, the plugin lays the color buttons in the selection popup out as a vertical list so the names stay readable.

## Contributing

Bug reports, ideas and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
