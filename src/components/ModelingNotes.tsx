import React, { useEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import {
  Archive,
  Bold,
  Check,
  Clock3,
  Code2,
  Columns3,
  Download,
  Eye,
  FileText,
  FolderOpen,
  FolderPlus,
  HardDrive,
  Hash,
  Italic,
  Link,
  List,
  ListOrdered,
  Pencil,
  Plus,
  Search,
  Sigma,
  Star,
  Tags,
  Trash2,
  Upload,
  X
} from "lucide-react";

type NoteView = "all" | "pinned" | "archived";
type EditorMode = "edit" | "split" | "preview";

interface ModelingNote {
  id: string;
  title: string;
  content: string;
  tags: string[];
  folder: string;
  pinned: boolean;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
  localFileName?: string;
}

interface ModelingNotesProps {
  account: string;
}

const STARTER_CONTENT = `# 我的第一篇数模笔记

欢迎来到 **数模学习笔记**。这里支持标准 Markdown、表格、任务清单、代码块和 LaTeX 数学公式。

## 今日学习目标

- [ ] 理解模型的适用场景
- [ ] 整理核心假设
- [ ] 复现一段求解代码

## 核心公式

行内公式：$y = f(x) + \\varepsilon$

$$
\\min_{x} \\quad f(x) \\\\
\\text{s.t.} \\quad g_i(x) \\le 0
$$

## 建模复盘

| 环节 | 我的记录 |
| --- | --- |
| 问题分析 | 明确目标、变量与约束 |
| 模型建立 | 写清假设和符号说明 |
| 结果检验 | 进行敏感性与稳健性分析 |

> 好的笔记不只是记录结论，还要记录“为什么这样建模”。
`;

const createNote = (overrides: Partial<ModelingNote> = {}): ModelingNote => {
  const now = Date.now();
  return {
    id: `note-${now}-${Math.random().toString(36).slice(2, 8)}`,
    title: "无标题笔记",
    content: "# 无标题笔记\n\n开始记录你的建模思路……\n",
    tags: [],
    folder: "学习笔记",
    pinned: false,
    archived: false,
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
};

const createStarterNotes = (): ModelingNote[] => [
  createNote({
    id: "modeling-notes-welcome",
    title: "数模学习笔记使用指南",
    content: STARTER_CONTENT,
    tags: ["入门", "Markdown"],
    folder: "学习笔记",
    pinned: true
  })
];

const formatNoteTime = (timestamp: number) => {
  const date = new Date(timestamp);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return `今天 ${date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`;
  }
  return date.toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
};

const getExcerpt = (content: string) => content
  .replace(/```[\s\S]*?```/g, "代码片段")
  .replace(/[#>*_`$\[\]()-]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, 82) || "暂无正文内容";

const sanitizeFilename = (title: string) => (title || "数模学习笔记")
  .replace(/[\\/:*?"<>|]/g, "-")
  .trim();

const fileNameMatchesTitle = (fileName: string, title: string) => {
  const baseName = sanitizeFilename(title) || "无标题笔记";
  const stem = fileName.replace(/\.md$/i, "");
  return stem === baseName || (stem.startsWith(`${baseName}-`) && /^\d+$/.test(stem.slice(baseName.length + 1)));
};

type DirectoryPickerWindow = Window & {
  showDirectoryPicker?: (options?: { id?: string; mode?: "read" | "readwrite" }) => Promise<FileSystemDirectoryHandle>;
};

type PermissionDirectoryHandle = FileSystemDirectoryHandle & {
  queryPermission?: (descriptor?: { mode?: "read" | "readwrite" }) => Promise<PermissionState>;
  requestPermission?: (descriptor?: { mode?: "read" | "readwrite" }) => Promise<PermissionState>;
};

const NOTES_DIRECTORY_DB = "mathhub-modeling-notes";
const NOTES_DIRECTORY_STORE = "directory-handles";

const openNotesDirectoryDb = () => new Promise<IDBDatabase>((resolve, reject) => {
  const request = indexedDB.open(NOTES_DIRECTORY_DB, 1);
  request.onupgradeneeded = () => {
    if (!request.result.objectStoreNames.contains(NOTES_DIRECTORY_STORE)) {
      request.result.createObjectStore(NOTES_DIRECTORY_STORE);
    }
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

const saveDirectoryHandle = async (account: string, handle: FileSystemDirectoryHandle) => {
  const database = await openNotesDirectoryDb();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(NOTES_DIRECTORY_STORE, "readwrite");
    transaction.objectStore(NOTES_DIRECTORY_STORE).put(handle, account);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  database.close();
};

const loadDirectoryHandle = async (account: string) => {
  const database = await openNotesDirectoryDb();
  const handle = await new Promise<FileSystemDirectoryHandle | undefined>((resolve, reject) => {
    const request = database.transaction(NOTES_DIRECTORY_STORE, "readonly").objectStore(NOTES_DIRECTORY_STORE).get(account);
    request.onsuccess = () => resolve(request.result as FileSystemDirectoryHandle | undefined);
    request.onerror = () => reject(request.error);
  });
  database.close();
  return handle;
};

const getDirectoryPermission = async (handle: FileSystemDirectoryHandle, requestIfNeeded: boolean) => {
  const permissionHandle = handle as PermissionDirectoryHandle;
  const descriptor = { mode: "readwrite" as const };
  const current = permissionHandle.queryPermission ? await permissionHandle.queryPermission(descriptor) : "granted";
  if (current === "granted" || !requestIfNeeded || !permissionHandle.requestPermission) return current;
  return permissionHandle.requestPermission(descriptor);
};

const writeMarkdownFile = async (directory: FileSystemDirectoryHandle, fileName: string, content: string) => {
  const fileHandle = await directory.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(content);
  await writable.close();
};

const createUniqueMarkdownFile = async (directory: FileSystemDirectoryHandle, title: string, content: string) => {
  const baseName = sanitizeFilename(title) || "无标题笔记";
  let index = 1;
  let fileName = `${baseName}.md`;
  while (true) {
    try {
      await directory.getFileHandle(fileName);
      index += 1;
      fileName = `${baseName}-${index}.md`;
    } catch {
      await writeMarkdownFile(directory, fileName, content);
      return fileName;
    }
  }
};

const renameMarkdownFile = async (
  directory: FileSystemDirectoryHandle,
  currentFileName: string,
  title: string,
  content: string
) => {
  const baseName = sanitizeFilename(title) || "无标题笔记";
  let index = 1;
  let nextFileName = `${baseName}.md`;
  if (nextFileName === currentFileName) return currentFileName;

  while (true) {
    try {
      await directory.getFileHandle(nextFileName);
      index += 1;
      nextFileName = `${baseName}-${index}.md`;
    } catch {
      break;
    }
  }

  await writeMarkdownFile(directory, nextFileName, content);
  try {
    await directory.removeEntry(currentFileName);
  } catch (error) {
    if ((error as DOMException)?.name !== "NotFoundError") throw error;
  }
  return nextFileName;
};

export default function ModelingNotes({ account }: ModelingNotesProps) {
  const storageKey = `user_${account}_modeling_notes`;
  const activeStorageKey = `user_${account}_modeling_notes_active`;
  const [notes, setNotes] = useState<ModelingNote[]>(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        const parsed = JSON.parse(saved) as ModelingNote[];
        if (Array.isArray(parsed)) return parsed;
      }
    } catch (error) {
      console.warn("[ModelingNotes] Failed to load saved notes:", error);
    }
    return createStarterNotes();
  });
  const [activeNoteId, setActiveNoteId] = useState(() => localStorage.getItem(activeStorageKey) || "modeling-notes-welcome");
  const [view, setView] = useState<NoteView>("all");
  const [editorMode, setEditorMode] = useState<EditorMode>("split");
  const [searchQuery, setSearchQuery] = useState("");
  const [folderFilter, setFolderFilter] = useState("全部文件夹");
  const [tagDraft, setTagDraft] = useState("");
  const [saveState, setSaveState] = useState<"saved" | "saving">("saved");
  const [directoryHandle, setDirectoryHandle] = useState<FileSystemDirectoryHandle | null>(null);
  const [directoryStatus, setDirectoryStatus] = useState<"loading" | "disconnected" | "permission" | "connected" | "error">("loading");
  const [directoryError, setDirectoryError] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const syncedContentRef = useRef<Record<string, string>>({});

  const activeNote = notes.find(note => note.id === activeNoteId) || null;
  const folders = useMemo(
    () => Array.from(new Set(notes.map(note => note.folder).filter(Boolean))).sort((a, b) => a.localeCompare(b, "zh-CN")),
    [notes]
  );

  const filteredNotes = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return notes
      .filter(note => {
        if (view === "all" && note.archived) return false;
        if (view === "pinned" && (!note.pinned || note.archived)) return false;
        if (view === "archived" && !note.archived) return false;
        if (folderFilter !== "全部文件夹" && note.folder !== folderFilter) return false;
        if (!query) return true;
        return [note.title, note.content, note.folder, ...note.tags].join(" ").toLowerCase().includes(query);
      })
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
  }, [folderFilter, notes, searchQuery, view]);

  useEffect(() => {
    setSaveState("saving");
    const timer = window.setTimeout(() => {
      localStorage.setItem(storageKey, JSON.stringify(notes));
      if (
        !activeNote?.localFileName
        || directoryStatus !== "connected"
        || syncedContentRef.current[activeNote.id] === activeNote.content
      ) setSaveState("saved");
    }, 320);
    return () => window.clearTimeout(timer);
  }, [activeNote?.localFileName, directoryStatus, notes, storageKey]);

  useEffect(() => {
    if (activeNoteId) localStorage.setItem(activeStorageKey, activeNoteId);
  }, [activeNoteId, activeStorageKey]);

  useEffect(() => {
    if (!activeNote && notes.length > 0) setActiveNoteId(notes[0].id);
  }, [activeNote, notes]);

  useEffect(() => {
    if (activeNote) setTagDraft(activeNote.tags.join(", "));
  }, [activeNote?.id]);

  useEffect(() => {
    let cancelled = false;
    void loadDirectoryHandle(account)
      .then(async handle => {
        if (cancelled || !handle) {
          if (!cancelled) setDirectoryStatus("disconnected");
          return;
        }
        setDirectoryHandle(handle);
        const permission = await getDirectoryPermission(handle, false);
        if (!cancelled) setDirectoryStatus(permission === "granted" ? "connected" : "permission");
      })
      .catch(() => {
        if (!cancelled) setDirectoryStatus("disconnected");
      });
    return () => { cancelled = true; };
  }, [account]);

  useEffect(() => {
    if (!directoryHandle || directoryStatus !== "connected" || !activeNote?.localFileName) return;
    if (syncedContentRef.current[activeNote.id] === activeNote.content) return;
    setSaveState("saving");
    const timer = window.setTimeout(() => {
      if (syncedContentRef.current[activeNote.id] === activeNote.content) {
        setSaveState("saved");
        return;
      }
      void writeMarkdownFile(directoryHandle, activeNote.localFileName!, activeNote.content)
        .then(() => {
          syncedContentRef.current[activeNote.id] = activeNote.content;
          setSaveState("saved");
          setDirectoryError("");
        })
        .catch(error => {
          console.warn("[ModelingNotes] Failed to write Markdown file:", error);
          setDirectoryStatus("permission");
          setDirectoryError("无法写入所选文件夹，请重新授权。");
          setSaveState("saved");
        });
    }, 520);
    return () => window.clearTimeout(timer);
  }, [activeNote?.content, activeNote?.id, activeNote?.localFileName, directoryHandle, directoryStatus]);

  useEffect(() => {
    if (!directoryHandle || directoryStatus !== "connected") return;
    notes.forEach(note => {
      if (note.localFileName) syncedContentRef.current[note.id] = note.content;
    });
    setFolderFilter(directoryHandle.name);
    setNotes(current => {
      let changed = false;
      const next = current.map(note => {
        if (!note.localFileName || note.folder === directoryHandle.name) return note;
        changed = true;
        return { ...note, folder: directoryHandle.name };
      });
      return changed ? next : current;
    });
  }, [directoryHandle, directoryStatus]);

  useEffect(() => {
    if (!directoryHandle || directoryStatus !== "connected" || !activeNote?.localFileName) return;
    if (fileNameMatchesTitle(activeNote.localFileName, activeNote.title)) return;

    const noteId = activeNote.id;
    const currentFileName = activeNote.localFileName;
    const currentTitle = activeNote.title;
    const currentContent = activeNote.content;
    setSaveState("saving");
    const timer = window.setTimeout(() => {
      void renameMarkdownFile(directoryHandle, currentFileName, currentTitle, currentContent)
        .then(nextFileName => {
          syncedContentRef.current[noteId] = currentContent;
          setNotes(current => current.map(note => note.id === noteId
            ? { ...note, localFileName: nextFileName, folder: directoryHandle.name, updatedAt: Date.now() }
            : note));
          setDirectoryError("");
          setSaveState("saved");
        })
        .catch(error => {
          console.warn("[ModelingNotes] Failed to rename Markdown file:", error);
          setDirectoryError("本地 Markdown 文件重命名失败，请检查文件是否被其他程序占用。");
          setSaveState("saved");
        });
    }, 650);
    return () => window.clearTimeout(timer);
  }, [activeNote?.id, activeNote?.localFileName, activeNote?.title, directoryHandle, directoryStatus]);

  const updateActiveNote = (changes: Partial<ModelingNote>) => {
    if (!activeNote) return;
    setNotes(current => current.map(note => note.id === activeNote.id
      ? { ...note, ...changes, updatedAt: Date.now() }
      : note));
  };

  const handleSelectDirectory = async (forcePicker = false) => {
    setDirectoryError("");
    try {
      if (directoryHandle && !forcePicker) {
        const permission = await getDirectoryPermission(directoryHandle, true);
        if (permission === "granted") {
          setDirectoryStatus("connected");
          return directoryHandle;
        }
      }
      const pickerWindow = window as DirectoryPickerWindow;
      if (!pickerWindow.showDirectoryPicker) {
        setDirectoryStatus("error");
        setDirectoryError("当前浏览器不支持直接选择文件夹，请使用最新版 Chrome 或 Edge。");
        return null;
      }
      const handle = await pickerWindow.showDirectoryPicker({ id: `mathhub-notes-${account}`, mode: "readwrite" });
      const permission = await getDirectoryPermission(handle, true);
      if (permission !== "granted") {
        setDirectoryStatus("permission");
        setDirectoryError("需要文件夹读写权限才能建立本地笔记。");
        return null;
      }
      setDirectoryHandle(handle);
      setDirectoryStatus("connected");
      await saveDirectoryHandle(account, handle);
      return handle;
    } catch (error) {
      if ((error as DOMException)?.name !== "AbortError") {
        console.warn("[ModelingNotes] Failed to select directory:", error);
        setDirectoryStatus("error");
        setDirectoryError("选择文件夹失败，请重试。");
      }
      return null;
    }
  };

  const handleCreateNote = async () => {
    const targetDirectory = directoryStatus === "connected" && directoryHandle
      ? directoryHandle
      : await handleSelectDirectory();
    if (!targetDirectory) return;
    const note = createNote({ folder: targetDirectory.name });
    try {
      const fileName = await createUniqueMarkdownFile(targetDirectory, note.title, note.content);
      note.localFileName = fileName;
      syncedContentRef.current[note.id] = note.content;
    } catch (error) {
      console.warn("[ModelingNotes] Failed to create Markdown file:", error);
      setDirectoryError("无法在所选文件夹中建立笔记，请检查写入权限。");
      setDirectoryStatus("permission");
      return;
    }
    setNotes(current => [note, ...current]);
    setActiveNoteId(note.id);
    setView("all");
    setEditorMode("edit");
    window.setTimeout(() => textareaRef.current?.focus(), 0);
  };

  const handleDeleteNote = () => {
    if (!activeNote || !window.confirm(`确定删除“${activeNote.title}”吗？此操作无法撤销。`)) return;
    const remaining = notes.filter(note => note.id !== activeNote.id);
    setNotes(remaining);
    setActiveNoteId(remaining[0]?.id || "");
  };

  const handleToggleArchive = () => {
    if (!activeNote) return;
    const willArchive = !activeNote.archived;
    updateActiveNote({ archived: willArchive });
    setView(willArchive ? "archived" : "all");
  };

  const handleExportNote = () => {
    if (!activeNote) return;
    const blob = new Blob([activeNote.content], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${sanitizeFilename(activeNote.title)}.md`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const handleImportNote = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const content = await file.text();
    const firstHeading = content.match(/^#\s+(.+)$/m)?.[1]?.trim();
    const note = createNote({
      title: firstHeading || file.name.replace(/\.md$/i, ""),
      content,
      tags: ["导入"],
      folder: "导入笔记"
    });
    setNotes(current => [note, ...current]);
    setActiveNoteId(note.id);
    setView("all");
  };

  const insertMarkdown = (before: string, after = "", placeholder = "文本") => {
    if (!activeNote) return;
    const textarea = textareaRef.current;
    if (!textarea) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selected = activeNote.content.slice(start, end) || placeholder;
    const nextContent = `${activeNote.content.slice(0, start)}${before}${selected}${after}${activeNote.content.slice(end)}`;
    updateActiveNote({ content: nextContent });
    window.requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(start + before.length, start + before.length + selected.length);
    });
  };

  const commitTags = () => {
    const tags = Array.from(new Set(tagDraft.split(/[,，]/).map(tag => tag.trim()).filter(Boolean))).slice(0, 8);
    updateActiveNote({ tags });
    setTagDraft(tags.join(", "));
  };

  const noteCount = notes.filter(note => !note.archived).length;
  const archivedCount = notes.filter(note => note.archived).length;
  const totalWords = notes.reduce((sum, note) => sum + note.content.replace(/\s/g, "").length, 0);

  const viewItems: Array<{ id: NoteView; label: string; count: number; icon: React.ReactNode }> = [
    { id: "all", label: "全部笔记", count: noteCount, icon: <FileText className="h-4 w-4" /> },
    { id: "pinned", label: "置顶笔记", count: notes.filter(note => note.pinned && !note.archived).length, icon: <Star className="h-4 w-4" /> },
    { id: "archived", label: "归档箱", count: archivedCount, icon: <Archive className="h-4 w-4" /> }
  ];

  return (
    <div className="mx-auto h-[calc(100vh-128px)] min-h-[620px] max-w-[1600px] animate-fade-in">
      <input ref={importInputRef} type="file" accept=".md,.markdown,text/markdown,text/plain" className="hidden" onChange={handleImportNote} />
      <div className="grid h-full min-h-0 grid-cols-[340px_minmax(0,1fr)] overflow-hidden rounded-[24px] border border-[#D0D7DE] bg-white shadow-[0_18px_48px_rgba(31,35,40,0.08)]">
        <aside className="flex min-h-0 flex-col border-r border-[#D8DEE4] bg-[#F6F8FA]">
          <div className="space-y-3 border-b border-[#D8DEE4] p-4">
            <div className="relative">
              <Search className="absolute left-3 top-3 h-4 w-4 text-[#8C959F]" />
              <input value={searchQuery} onChange={event => setSearchQuery(event.target.value)} placeholder="搜索标题、正文或标签" className="w-full rounded-xl border border-[#D0D7DE] bg-white py-2.5 pl-9 pr-8 text-xs outline-none transition focus:border-[#0969DA] focus:ring-2 focus:ring-blue-100" />
              {searchQuery && <button type="button" onClick={() => setSearchQuery("")} className="absolute right-2.5 top-3 text-[#8C959F] hover:text-[#24292F]"><X className="h-4 w-4" /></button>}
            </div>

            <button
              type="button"
              onClick={() => void handleSelectDirectory(directoryStatus === "connected")}
              className={`flex w-full items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left transition ${directoryStatus === "connected" ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-blue-200 bg-blue-50 text-[#0969DA] hover:bg-blue-100"}`}
            >
              {directoryStatus === "connected" ? <HardDrive className="h-4 w-4 shrink-0" /> : <FolderPlus className="h-4 w-4 shrink-0" />}
              <span className="min-w-0 flex-1">
                <span className="block text-[10px] font-semibold opacity-75">{directoryStatus === "connected" ? "本地笔记文件夹" : "新建前请先选择"}</span>
                <span className="block truncate text-xs font-black">{directoryStatus === "loading" ? "正在读取文件夹…" : directoryStatus === "connected" ? directoryHandle?.name : directoryStatus === "permission" ? "点击重新授权文件夹" : "选择本地文件夹"}</span>
              </span>
              <span className="text-[10px] font-bold">{directoryStatus === "connected" ? "更换" : "选择"}</span>
            </button>
            {directoryError && <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[10px] leading-4 text-rose-600">{directoryError}</div>}

            <div className="grid grid-cols-2 gap-2">
              <label className="relative">
                <span className="mb-1 block text-[10px] font-bold text-[#8C959F]">笔记范围</span>
                <select value={view} onChange={event => setView(event.target.value as NoteView)} className="w-full appearance-none rounded-xl border border-[#D0D7DE] bg-white px-3 py-2 pr-7 text-xs font-bold text-[#24292F] outline-none transition focus:border-[#0969DA] focus:ring-2 focus:ring-blue-100">
                  {viewItems.map(item => <option key={item.id} value={item.id}>{item.label}（{item.count}）</option>)}
                </select>
                <span className="pointer-events-none absolute bottom-2.5 right-3 text-[10px] text-[#8C959F]">▼</span>
              </label>
              <label className="relative">
                <span className="mb-1 block text-[10px] font-bold text-[#8C959F]">文件夹</span>
                <select value={folderFilter} onChange={event => setFolderFilter(event.target.value)} className="w-full appearance-none rounded-xl border border-[#D0D7DE] bg-white px-3 py-2 pr-7 text-xs font-bold text-[#24292F] outline-none transition focus:border-[#0969DA] focus:ring-2 focus:ring-blue-100">
                  {["全部文件夹", ...folders].map(folder => <option key={folder} value={folder}>{folder}</option>)}
                </select>
                <span className="pointer-events-none absolute bottom-2.5 right-3 text-[10px] text-[#8C959F]">▼</span>
              </label>
            </div>

            <div className="flex items-center justify-between rounded-xl border border-blue-100 bg-blue-50/70 px-3 py-2 text-[11px]">
              <span className="font-bold text-[#0969DA]">{filteredNotes.length} 篇当前笔记</span>
              <span className="text-[#57606A]">共 {noteCount} 篇 · {totalWords > 9999 ? `${Math.round(totalWords / 1000)}k` : totalWords} 字</span>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-2.5">
            {filteredNotes.length > 0 ? filteredNotes.map(note => (
              <button
                key={note.id}
                type="button"
                onClick={() => setActiveNoteId(note.id)}
                className={`mb-1.5 w-full rounded-xl border p-3 text-left transition ${activeNote?.id === note.id ? "border-blue-200 bg-blue-50 shadow-sm" : "border-transparent hover:border-[#D8DEE4] hover:bg-[#F6F8FA]"}`}
              >
                <div className="flex items-start gap-2">
                  <h3 className="min-w-0 flex-1 truncate text-sm font-extrabold text-[#24292F]">{note.title || "无标题笔记"}</h3>
                  {note.pinned && <Star className="h-3.5 w-3.5 shrink-0 fill-amber-400 text-amber-400" />}
                </div>
                <p className="mt-1 line-clamp-2 text-[11px] leading-5 text-[#57606A]">{getExcerpt(note.content)}</p>
                <div className="mt-2 flex items-center gap-2 text-[10px] text-[#8C959F]">
                  <Clock3 className="h-3 w-3" /><span>{formatNoteTime(note.updatedAt)}</span>
                  {note.tags.slice(0, 2).map(tag => <span key={tag} className="max-w-[74px] truncate rounded bg-[#EFF2F5] px-1.5 py-0.5 text-[#57606A]">#{tag}</span>)}
                </div>
              </button>
            )) : (
              <div className="flex h-full flex-col items-center justify-center px-5 text-center text-[#8C959F]">
                <Search className="mb-3 h-8 w-8" />
                <p className="text-sm font-bold text-[#57606A]">没有找到笔记</p>
                <p className="mt-1 text-xs">试试其他关键词或分类</p>
              </div>
            )}
          </div>

          <div className="border-t border-[#D8DEE4] px-4 py-3 text-[11px] text-[#57606A]">
            <div className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-1.5 font-bold text-[#24292F]"><Check className="h-3.5 w-3.5 text-emerald-600" />本机自动保存</span>
              <span className="text-[#8C959F]">支持 .md 导入导出</span>
            </div>
          </div>
        </aside>

        <main className="flex min-h-0 min-w-0 flex-col bg-white">
          {activeNote ? (
            <>
              <div className="flex items-center gap-3 border-b border-[#D8DEE4] px-5 py-3">
                <input
                  value={activeNote.title}
                  onChange={event => updateActiveNote({ title: event.target.value })}
                  className="min-w-0 flex-1 bg-transparent text-lg font-black text-[#1F2328] outline-none placeholder:text-[#8C959F]"
                  placeholder="笔记标题"
                />
                <span className={`flex items-center gap-1 text-[10px] font-semibold ${saveState === "saved" ? "text-emerald-600" : "text-amber-600"}`}>
                  {saveState === "saved" ? <Check className="h-3.5 w-3.5" /> : <Clock3 className="h-3.5 w-3.5 animate-pulse" />}
                  {saveState === "saved" ? "已保存" : "保存中"}
                </span>
                {activeNote.localFileName && <span className="hidden max-w-[130px] truncate rounded-md bg-emerald-50 px-2 py-1 text-[10px] font-semibold text-emerald-700 xl:block" title={activeNote.localFileName}>{activeNote.localFileName}</span>}
                <div className="flex rounded-lg border border-[#D0D7DE] bg-[#F6F8FA] p-0.5">
                  {([
                    ["edit", Pencil, "编辑"],
                    ["split", Columns3, "分栏"],
                    ["preview", Eye, "预览"]
                  ] as const).map(([mode, Icon, label]) => (
                    <button key={mode} type="button" onClick={() => setEditorMode(mode)} title={label} className={`rounded-md p-1.5 transition ${editorMode === mode ? "bg-white text-[#0969DA] shadow-sm" : "text-[#8C959F] hover:text-[#24292F]"}`}><Icon className="h-4 w-4" /></button>
                  ))}
                </div>
                <button type="button" onClick={() => updateActiveNote({ pinned: !activeNote.pinned })} title={activeNote.pinned ? "取消置顶" : "置顶"} className={`rounded-lg border p-2 transition ${activeNote.pinned ? "border-amber-200 bg-amber-50 text-amber-500" : "border-[#D0D7DE] text-[#57606A] hover:bg-[#F6F8FA]"}`}><Star className={`h-4 w-4 ${activeNote.pinned ? "fill-current" : ""}`} /></button>
                <button type="button" onClick={handleExportNote} title="导出 Markdown" className="rounded-lg border border-[#D0D7DE] p-2 text-[#57606A] transition hover:bg-[#F6F8FA] hover:text-[#0969DA]"><Download className="h-4 w-4" /></button>
                <button type="button" onClick={handleToggleArchive} title={activeNote.archived ? "移出归档" : "归档"} className="rounded-lg border border-[#D0D7DE] p-2 text-[#57606A] transition hover:bg-[#F6F8FA] hover:text-[#0969DA]"><Archive className="h-4 w-4" /></button>
                <button type="button" onClick={handleDeleteNote} title="删除笔记" className="rounded-lg border border-rose-200 p-2 text-rose-500 transition hover:bg-rose-50"><Trash2 className="h-4 w-4" /></button>
                <div className="h-6 w-px shrink-0 bg-[#D8DEE4]" />
                <button type="button" onClick={() => importInputRef.current?.click()} className="flex shrink-0 items-center gap-1.5 rounded-lg border border-[#D0D7DE] bg-white px-3 py-2 text-xs font-bold text-[#24292F] transition hover:bg-[#F6F8FA]">
                  <Upload className="h-4 w-4" />导入 Markdown
                </button>
                <button type="button" onClick={handleCreateNote} className="flex shrink-0 items-center gap-1.5 rounded-lg bg-[#0969DA] px-3 py-2 text-xs font-bold text-white shadow-sm transition hover:bg-[#075CBD]">
                  <Plus className="h-4 w-4" />新建笔记
                </button>
              </div>

              <div className="flex flex-wrap items-center gap-3 border-b border-[#D8DEE4] bg-[#FBFCFD] px-5 py-2.5">
                <label className="flex min-w-[180px] flex-1 items-center gap-2 text-xs text-[#57606A]">
                  <FolderOpen className="h-3.5 w-3.5" />
                  <input
                    value={activeNote.localFileName && directoryHandle ? directoryHandle.name : activeNote.folder}
                    onChange={event => updateActiveNote({ folder: event.target.value })}
                    readOnly={Boolean(activeNote.localFileName && directoryHandle)}
                    title={activeNote.localFileName && directoryHandle ? `本地文件夹：${directoryHandle.name}` : "内部分类名称"}
                    className={`w-full bg-transparent font-semibold text-[#24292F] outline-none ${activeNote.localFileName && directoryHandle ? "cursor-default" : ""}`}
                    placeholder="文件夹名称"
                  />
                </label>
                <div className="h-4 w-px bg-[#D8DEE4]" />
                <label className="flex min-w-[240px] flex-[1.4] items-center gap-2 text-xs text-[#57606A]">
                  <Tags className="h-3.5 w-3.5" />
                  <input value={tagDraft} onChange={event => setTagDraft(event.target.value)} onBlur={commitTags} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); commitTags(); } }} className="w-full bg-transparent text-[#24292F] outline-none" placeholder="标签，用逗号分隔" />
                </label>
              </div>

              {editorMode !== "preview" && (
                <div className="flex items-center gap-1 overflow-x-auto border-b border-[#D8DEE4] bg-white px-4 py-2">
                  {[
                    { label: "标题", icon: <Hash className="h-4 w-4" />, action: () => insertMarkdown("## ", "", "小节标题") },
                    { label: "粗体", icon: <Bold className="h-4 w-4" />, action: () => insertMarkdown("**", "**", "重点内容") },
                    { label: "斜体", icon: <Italic className="h-4 w-4" />, action: () => insertMarkdown("*", "*", "强调内容") },
                    { label: "列表", icon: <List className="h-4 w-4" />, action: () => insertMarkdown("- ", "", "列表项") },
                    { label: "编号", icon: <ListOrdered className="h-4 w-4" />, action: () => insertMarkdown("1. ", "", "列表项") },
                    { label: "链接", icon: <Link className="h-4 w-4" />, action: () => insertMarkdown("[", "](https://)", "链接文字") },
                    { label: "代码", icon: <Code2 className="h-4 w-4" />, action: () => insertMarkdown("```python\n", "\n```", "# 在这里编写代码") },
                    { label: "公式", icon: <Sigma className="h-4 w-4" />, action: () => insertMarkdown("$$\n", "\n$$", "y = f(x)") }
                  ].map(item => <button key={item.label} type="button" onClick={item.action} title={item.label} className="rounded-lg p-2 text-[#57606A] transition hover:bg-blue-50 hover:text-[#0969DA]">{item.icon}</button>)}
                  <div className="ml-auto whitespace-nowrap px-2 text-[10px] font-semibold text-[#8C959F]">Markdown · {activeNote.content.replace(/\s/g, "").length} 字</div>
                </div>
              )}

              <div className={`grid min-h-0 flex-1 ${editorMode === "split" ? "grid-cols-2" : "grid-cols-1"}`}>
                {editorMode !== "preview" && (
                  <section className={`flex min-h-0 flex-col bg-[#FBFCFD] ${editorMode === "split" ? "border-r border-[#D8DEE4]" : ""}`}>
                    <div className="border-b border-[#EAECEF] px-6 py-2 text-[10px] font-bold tracking-wide text-[#8C959F]">MARKDOWN 源码</div>
                    <textarea
                      ref={textareaRef}
                      value={activeNote.content}
                      onChange={event => updateActiveNote({ content: event.target.value })}
                      spellCheck={false}
                      className="h-full min-h-0 w-full flex-1 resize-none bg-[#FBFCFD] p-6 font-mono text-[13px] leading-7 text-[#24292F] outline-none"
                      placeholder="# 开始记录你的数学建模学习笔记……"
                    />
                  </section>
                )}
                {editorMode !== "edit" && (
                  <section className="flex min-h-0 flex-col bg-white">
                    <div className="border-b border-[#EAECEF] px-7 py-2 text-[10px] font-bold tracking-wide text-[#0969DA]">实时预览</div>
                    <article className="markdown-body modeling-note-preview min-h-0 flex-1 overflow-y-auto p-7">
                      <Markdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>{activeNote.content || "*暂无内容*"}</Markdown>
                    </article>
                  </section>
                )}
              </div>
            </>
          ) : (
            <div className="flex h-full flex-col items-center justify-center text-center">
              <span className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-blue-50 text-[#0969DA]"><FileText className="h-8 w-8" /></span>
              <h2 className="text-xl font-black text-[#24292F]">开始建立你的数模知识库</h2>
              <p className="mt-2 max-w-sm text-sm leading-6 text-[#57606A]">记录模型理解、公式推导、代码实验和赛后复盘，让零散知识逐渐形成体系。</p>
              <div className="mt-5 flex items-center gap-2">
                <button type="button" onClick={() => importInputRef.current?.click()} className="flex items-center gap-2 rounded-xl border border-[#D0D7DE] bg-white px-5 py-2.5 text-sm font-bold text-[#24292F]"><Upload className="h-4 w-4" />导入 Markdown</button>
                <button type="button" onClick={handleCreateNote} className="flex items-center gap-2 rounded-xl bg-[#0969DA] px-5 py-2.5 text-sm font-bold text-white"><Plus className="h-4 w-4" />新建第一篇笔记</button>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
