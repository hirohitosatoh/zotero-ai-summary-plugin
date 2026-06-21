import { getPref } from "../../utils/prefs";

const NOTE_TITLE = "ChatGPT要約";
const DEFAULT_MODEL = "gpt-4.1-mini";
const MAX_INPUT_LENGTH = 120_000;

type SummaryPrompt = {
  name: string;
  prompt: string;
};

type ProgressWindow = InstanceType<typeof ztoolkit.ProgressWindow>;

export function registerAiSummaryMenu() {
  ztoolkit.Menu.register("item", {
    tag: "menuitem",
    id: "zotero-itemmenu-ai-summary",
    label: "ChatGPTによる要約",
    commandListener: () => summarizeSelectedItems().catch(handleError),
  });
}

async function summarizeSelectedItems() {
  const items = ztoolkit
    .getGlobal("ZoteroPane")
    .getSelectedItems()
    .filter((item: Zotero.Item) => item.isRegularItem());

  if (!items.length) {
    ztoolkit.getGlobal("alert")("要約対象のアイテムを選択してください。");
    return;
  }

  const prompt = await choosePrompt();
  if (!prompt) return;

  if (!(await confirmOverwriteIfNeeded(items))) return;

  const progressWin = new ztoolkit.ProgressWindow(addon.data.config.addonName, {
    closeOnClick: true,
    closeTime: -1,
  }).show();
  progressWin.createLine({
    text: `0/${items.length} 準備中`,
    type: "default",
    progress: 0,
    idx: 0,
  });

  let completed = 0;
  for (const item of items) {
    const index = completed + 1;
    const title = item.getDisplayTitle();

    updateProgress(progressWin, index, items.length, "本文抽出中", title);
    const sourceText = await getItemText(item);
    if (!sourceText.trim()) {
      completed++;
      updateProgress(
        progressWin,
        completed,
        items.length,
        "本文が見つかりません",
        title,
      );
      continue;
    }

    updateProgress(progressWin, index, items.length, "API呼び出し中", title);
    const summary = await requestSummary(prompt.prompt, sourceText);

    updateProgress(progressWin, index, items.length, "ノート保存中", title);
    await upsertSummaryNote(item, summary);
    completed++;
    updateProgress(progressWin, completed, items.length, "完了", title);
  }

  progressWin.changeLine({
    text: `${completed}/${items.length} 要約が完了しました`,
    type: "success",
    progress: 100,
    idx: 0,
  });
  progressWin.startCloseTimer(5000);
}

async function choosePrompt(): Promise<SummaryPrompt | undefined> {
  const prompts = getSummaryPrompts();
  if (!prompts.length) {
    ztoolkit.getGlobal("alert")("要約プロンプトが設定されていません。");
    return undefined;
  }
  if (prompts.length === 1) return prompts[0];

  const dialogData: { [key: string]: any } = {
    promptIndex: "0",
  };
  const dialog = new ztoolkit.Dialog(2, 2)
    .addCell(0, 0, {
      tag: "label",
      properties: { innerHTML: "要約プロンプト" },
    })
    .addCell(0, 1, {
      tag: "select",
      namespace: "html",
      attributes: {
        "data-bind": "promptIndex",
        "data-prop": "value",
      },
      children: prompts.map((prompt, index) => ({
        tag: "option",
        namespace: "html",
        attributes: { value: String(index) },
        properties: { innerText: prompt.name },
      })),
    })
    .addButton("OK", "confirm")
    .addButton("キャンセル", "cancel")
    .setDialogData(dialogData)
    .open("ChatGPTによる要約");

  addon.data.dialog = dialog;
  await dialogData.unloadLock.promise;
  addon.data.dialog = undefined;

  if (dialogData._lastButtonId !== "confirm") return undefined;
  return prompts[Number(dialogData.promptIndex)];
}

function getSummaryPrompts(): SummaryPrompt[] {
  const raw = (getPref("summaryPrompts") || "[]") as string;
  try {
    const prompts = JSON.parse(raw) as SummaryPrompt[];
    return prompts
      .filter((prompt) => prompt.prompt)
      .map((prompt) => ({
        name: prompt.name || "(Untitled)",
        prompt: prompt.prompt,
      }));
  } catch {
    ztoolkit.getGlobal("alert")("要約プロンプトJSONを解析できません。");
    return [];
  }
}

async function confirmOverwriteIfNeeded(items: Zotero.Item[]) {
  const existingCount = items.filter((item) => findSummaryNote(item)).length;
  if (!existingCount) return true;

  return ztoolkit.getGlobal("confirm")(
    `既存の「${NOTE_TITLE}」メモが ${existingCount} 件あります。上書きしますか？`,
  );
}

async function getItemText(item: Zotero.Item): Promise<string> {
  const chunks: string[] = [];
  for (const attachmentID of item.getAttachments()) {
    const attachment = Zotero.Items.get(attachmentID);
    if (!attachment) continue;

    const text = await attachment.attachmentText;
    if (text?.trim()) chunks.push(text);
  }
  return chunks.join("\n\n");
}

async function requestSummary(instructions: string, sourceText: string) {
  const apiKey = ((getPref("openaiApiKey") || "") as string).trim();
  if (!apiKey) {
    throw new Error("OpenAI APIキーが設定されていません。");
  }

  const model = ((getPref("openaiModel") || DEFAULT_MODEL) as string).trim();
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      instructions,
      input: sourceText.slice(0, MAX_INPUT_LENGTH),
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    if (response.status === 401) {
      throw new Error(
        `OpenAI API key was rejected. Please re-paste the full Platform API key in preferences. Details: ${errorText}`,
      );
    }
    throw new Error(`OpenAI API error: ${response.status} ${errorText}`);
  }

  return extractOutputText(await response.json());
}

function extractOutputText(response: any): string {
  if (response.output_text) return response.output_text;

  const text =
    response.output
      ?.flatMap((item: any) => item.content ?? [])
      ?.map((content: any) => content.text ?? "")
      ?.join("\n")
      ?.trim() ?? "";

  if (!text) throw new Error("OpenAI APIの応答から要約文を取得できません。");
  return text;
}

async function upsertSummaryNote(parent: Zotero.Item, summary: string) {
  const note = findSummaryNote(parent) ?? new Zotero.Item("note");
  note.libraryID = parent.libraryID;
  note.parentItemID = parent.id;
  note.setNote(
    `<h1>${NOTE_TITLE}</h1><p>${escapeHTML(summary).replace(
      /\n/g,
      "<br/>",
    )}</p>`,
  );
  await note.saveTx();
}

function findSummaryNote(parent: Zotero.Item): Zotero.Item | undefined {
  for (const noteID of parent.getNotes(false)) {
    const note = Zotero.Items.get(noteID);
    if (note?.getNoteTitle() === NOTE_TITLE) return note;
  }
  return undefined;
}

function updateProgress(
  progressWin: ProgressWindow,
  current: number,
  total: number,
  status: string,
  title: string,
) {
  const percentage = Math.round((current / total) * 100);
  progressWin.changeLine({
    text: `${current}/${total} ${status}: ${title}`,
    progress: percentage,
    idx: 0,
  });
}

function escapeHTML(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function handleError(error: unknown) {
  ztoolkit.log("AI summary error", error);
  const message = error instanceof Error ? error.message : String(error);
  ztoolkit.getGlobal("alert")(
    `ChatGPTによる要約に失敗しました。\n\n${message}`,
  );
}
