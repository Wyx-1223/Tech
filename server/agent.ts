import type { ChatMessage } from "../shared/chat.ts";
import type { TaskStore } from "./task-store.ts";

export type { ChatMessage } from "../shared/chat.ts";

interface Task {
  id: string;
  title: string;
  done: boolean;
}

// ---------- 意图关键词 ----------
const COMPLETE_WORDS = [
  "完成了",
  "做完了",
  "做好了",
  "买好了",
  "洗好了",
  "写完了",
  "搞定了",
  "弄完了",
  "办好了",
  "结束了",
  "已完成",
  "完成",
  "做完",
  "搞定",
  "弄好",
  "买好",
];
const DELETE_WORDS = ["删除", "删掉", "取消", "去掉", "撤销", "不做了", "移除", "删了", "这条删掉"];
const LIST_WORDS = [
  "哪些任务",
  "哪些待办",
  "看看清单",
  "看看任务",
  "看看我的待办",
  "任务列表",
  "待办清单",
  "清单",
  "列表",
  "还有什么",
  "我要做什么",
  "有哪些",
  "待办有哪些",
];
const CREATE_WORDS = [
  "记一下",
  "记录一下",
  "提醒我",
  "添加",
  "再加一条",
  "再记一条",
  "记一条",
  "加一条",
  "安排一下",
  "安排",
  "记住",
  "帮我记",
  "我要",
  "打算",
  "准备",
  "别忘了",
];

// 提取任务标题时需要剥离的填充词 / 时间词（长词优先）
const STRIP_WORDS = [
  "帮我",
  "给我",
  "一下",
  "记一下",
  "记录一下",
  "提醒我",
  "记住",
  "记得",
  "添加",
  "再加一条",
  "再记一条",
  "记一条",
  "加一条",
  "安排一下",
  "安排",
  "我要",
  "我想",
  "打算",
  "准备",
  "把",
  "别忘了",
  "待办事项",
  "待办",
  "事项",
  "明天",
  "今天",
  "后天",
  "大后天",
  "下周",
  "晚上",
  "早上",
  "下午",
  "上午",
  "这条",
  "那个",
  "这个",
];

const PUNCTUATION = /[\s，。！？、,.!?~～…「」"'（）()]/g;
const MATCH_THRESHOLD = 0.2;

type Intent = "create" | "list" | "complete" | "delete" | "unknown";

function hasAny(text: string, words: string[]): boolean {
  return words.some((word) => text.includes(word));
}

function normalize(text: string): string {
  return text.replace(PUNCTUATION, "");
}

function bigrams(text: string): Set<string> {
  const normalized = normalize(text);
  if (normalized.length <= 1) return normalized ? new Set([normalized]) : new Set();
  return new Set(
    Array.from({ length: normalized.length - 1 }, (_, i) => normalized.slice(i, i + 2)),
  );
}

function charSet(text: string): Set<string> {
  return new Set(normalize(text));
}

function intersectionSize<T>(a: Set<T>, b: Set<T>): number {
  let count = 0;
  for (const item of a) if (b.has(item)) count += 1;
  return count;
}

/** 在候选任务里找与话术最匹配的一条，返回任务与相似度得分。 */
function matchTask(message: string, tasks: Task[]): { task: Task; score: number } | null {
  const msg = normalize(message);
  if (!msg || tasks.length === 0) return null;

  const msgBigrams = bigrams(msg);
  const msgChars = charSet(msg);
  let best: { task: Task; score: number } | null = null;

  for (const task of tasks) {
    const title = normalize(task.title);
    const titleBigrams = bigrams(title);
    const titleChars = charSet(title);
    if (titleChars.size === 0) continue;

    const biInter = intersectionSize(msgBigrams, titleBigrams);
    const biUnion = msgBigrams.size + titleBigrams.size - biInter;
    const biScore = biUnion === 0 ? 0 : biInter / biUnion;

    const chInter = intersectionSize(msgChars, titleChars);
    const chUnion = msgChars.size + titleChars.size - chInter;
    const chScore = chUnion === 0 ? 0 : chInter / chUnion;

    let score = (biScore + chScore) / 2;
    if (title && title.includes(msg)) score += 0.3;
    else if ([...titleChars].every((char) => msgChars.has(char))) score += 0.2;
    if (msg && msg.includes(title)) score += 0.3;

    if (!best || score > best.score) best = { task, score };
  }
  return best;
}

function extractTitle(text: string): string {
  let content = text;
  for (const word of [...STRIP_WORDS].sort((a, b) => b.length - a.length)) {
    content = content.replaceAll(word, "");
  }
  content = content.replace(PUNCTUATION, "").trim();
  return content;
}

function parseIntent(text: string): Intent {
  if (hasAny(text, LIST_WORDS)) return "list";
  if (hasAny(text, COMPLETE_WORDS)) return "complete";
  if (hasAny(text, DELETE_WORDS)) return "delete";
  if (hasAny(text, CREATE_WORDS)) return "create";

  // 疑问句不属于任务操作
  if (/[吗？?]|怎么|什么|为什么|谁|哪/.test(text)) return "unknown";

  const stripped = text.replace(PUNCTUATION, "").trim();
  if (stripped.length > 1 && stripped.length <= 200) return "create";
  return "unknown";
}

function formatList(tasks: Task[]): string {
  if (tasks.length === 0) return "清单里目前没有任务，你可以直接说要记的事情。";
  const pending = tasks.filter((t) => !t.done);
  const completed = tasks.filter((t) => t.done);
  const lines = ["当前清单："];
  for (const task of pending) lines.push(`- [待办] ${task.title}`);
  for (const task of completed) lines.push(`- [完成] ${task.title}`);
  lines.push(`共 ${pending.length} 条待办，${completed.length} 条已完成。`);
  return lines.join("\n");
}

// 从这里开始实现智能体。messages 包含本轮对话历史，最后一条是最新的用户消息。
export async function reply(messages: ChatMessage[], tasks: TaskStore): Promise<string> {
  const latest = messages.at(-1);
  const text = (latest?.content ?? "").trim();
  if (!text) return "我没听清，请再说一遍。";

  const intent = parseIntent(text);

  if (intent === "create") {
    const title = extractTitle(text);
    if (!title) return "你想记点什么？再说一遍具体事情吧。";
    if (title.length > 200) return "这条任务太长了，麻烦缩短到 200 字以内。";
    const task = tasks.create(title);
    return `好的，已经记下「${task.title}」。`;
  }

  if (intent === "list") {
    return formatList(tasks.list() as Task[]);
  }

  if (intent === "complete") {
    const pending = (tasks.list() as Task[]).filter((t) => !t.done);
    if (pending.length === 0) return "当前没有待办任务，先记一条吧。";
    const matched = matchTask(text, pending);
    if (!matched || matched.score < MATCH_THRESHOLD) {
      return "我没确定是哪一条，你可以说清楚任务名称，或先查看清单。";
    }
    tasks.update(matched.task.id, { done: true });
    return `已把「${matched.task.title}」标记为完成。`;
  }

  if (intent === "delete") {
    const all = tasks.list() as Task[];
    if (all.length === 0) return "清单里目前什么都没有。";
    const matched = matchTask(text, all);
    if (!matched || matched.score < MATCH_THRESHOLD) {
      return "我没确定要删掉哪一条，你可以再说具体一点。";
    }
    tasks.remove(matched.task.id);
    return `已删除「${matched.task.title}」。`;
  }

  return "抱歉，我没听懂。你可以让我记下一件事、查看清单、标记完成或删除任务。";
}
