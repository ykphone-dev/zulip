// The Slack-style file list of the 옆커폰 fork: the data side.
//
// One component serves three places — the rail's 파일 view (every
// channel), a channel's 파일 tab, and the 파일 tab of the search
// results page — because all three are the same question asked of a
// "has:attachment" narrow: which files are in these messages?
//
// Zulip has no endpoint that lists files somebody else uploaded
// (/json/attachments lists one's own), so the rows are read out of the
// rendered messages the narrow brings back. That also means the list
// holds exactly the files in messages the user may read.

import {$t} from "./i18n.ts";
import type {RawMessage} from "./message_store.ts";
import * as people from "./people.ts";
import * as stream_data from "./stream_data.ts";
import * as timerender from "./timerender.ts";
import * as ykphone_activity from "./ykphone_activity.ts";
import * as ykphone_highlight from "./ykphone_highlight.ts";

export type FileKind = "image" | "video" | "audio" | "document" | "archive" | "other";

export const FILE_KINDS: FileKind[] = ["image", "video", "audio", "document", "archive", "other"];

export type FileRow = {
    // A file is listed once per message it is in.
    key: string;
    message_id: number;
    name: string;
    // The file itself: the row's thumbnail links to it, which is
    // what the lightbox opens.
    url: string;
    // The path inside /user_uploads/: what makes a file the same file
    // when it was shared in more than one message.
    path_id: string;
    kind: FileKind;
    icon: string;
    thumbnail_url: string | undefined;
    // The message the file was shared in.
    message_url: string;
    sender_id: number;
    sender_name: string;
    avatar_url: string;
    stream_id: number | undefined;
    context_label: string;
    timestamp: number;
    date_label: string;
};

const EXTENSIONS: Record<FileKind, Set<string>> = {
    image: new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "heic", "avif", "tiff"]),
    video: new Set(["mp4", "mov", "webm", "avi", "mkv", "m4v", "wmv"]),
    audio: new Set(["mp3", "m4a", "wav", "ogg", "flac", "aac", "opus"]),
    document: new Set([
        "pdf",
        "doc",
        "docx",
        "xls",
        "xlsx",
        "csv",
        "ppt",
        "pptx",
        "hwp",
        "hwpx",
        "txt",
        "md",
        "rtf",
        "odt",
        "ods",
        "odp",
    ]),
    archive: new Set(["zip", "tar", "gz", "tgz", "7z", "rar", "bz2", "xz"]),
    other: new Set(),
};

const KIND_ICONS: Record<FileKind, string> = {
    image: "mobile-image",
    video: "play-circle",
    audio: "voice-call",
    document: "file-text",
    archive: "archive",
    other: "attachment",
};

export function kind_label(kind: FileKind): string {
    const labels: Record<FileKind, string> = {
        image: $t({defaultMessage: "Images"}),
        video: $t({defaultMessage: "Videos"}),
        audio: $t({defaultMessage: "Audio"}),
        document: $t({defaultMessage: "Documents"}),
        archive: $t({defaultMessage: "Archives"}),
        other: $t({defaultMessage: "Other files"}),
    };
    return labels[kind];
}

function without_query(url: string): string {
    const query = url.indexOf("?");
    return query === -1 ? url : url.slice(0, query);
}

export function extension_of(name: string): string {
    const base = without_query(name);
    const dot = base.lastIndexOf(".");
    return dot === -1 ? "" : base.slice(dot + 1).toLowerCase();
}

export function is_file_kind(value: string): value is FileKind {
    return FILE_KINDS.some((kind) => kind === value);
}

export function kind_of(name: string): FileKind {
    const extension = extension_of(name);
    for (const kind of FILE_KINDS) {
        if (EXTENSIONS[kind].has(extension)) {
            return kind;
        }
    }
    return "other";
}

function decode_entities(text: string): string {
    return text
        .replaceAll("&lt;", "<")
        .replaceAll("&gt;", ">")
        .replaceAll("&quot;", '"')
        .replaceAll("&#39;", "'")
        .replaceAll("&amp;", "&");
}

function file_name_from_url(url: string): string {
    const path = without_query(url);
    const segment = path.slice(path.lastIndexOf("/") + 1);
    try {
        return decodeURIComponent(segment);
    } catch {
        return segment;
    }
}

export function path_id_of(url: string): string {
    const marker = "/user_uploads/";
    const index = url.indexOf(marker);
    return index === -1 ? url : url.slice(index + marker.length);
}

type Upload = {url: string; name: string; thumbnail_url: string | undefined};

// An upload is a link whose *path* is under /user_uploads/; a link
// that merely mentions the word somewhere else is not a file. The name
// that comes out of one is attacker-chosen text (a poster picks both
// the link's words and its path), so nothing downstream may treat it
// as markup — see row_contexts.
const UPLOAD_HREF = /^(?:https?:\/\/[^/]*)?\/user_uploads\//i;

// The uploads in one rendered message, newest markup first: Zulip
// renders an upload as a link and, for an image, a preview block that
// points at the same file, so each file is taken once and the preview's
// thumbnail wins.
export function uploads_in_html(html: string): Upload[] {
    const uploads = new Map<string, Upload>();
    const anchors = html.matchAll(/<a\b[^>]*?\bhref="([^"]*)"[^>]*>(.*?)<\/a>/gis);
    for (const match of anchors) {
        const href = decode_entities(match[1]!);
        if (!UPLOAD_HREF.test(href)) {
            continue;
        }
        const inner = match[2]!;
        const image = /<img\b[^>]*?\bsrc="([^"]*)"/i.exec(inner);
        const text = ykphone_activity.plain_text_snippet(inner);
        const name = text === "" || image !== null ? file_name_from_url(href) : text;
        const previous = uploads.get(href);
        uploads.set(href, {
            url: href,
            name: previous?.name ?? name,
            thumbnail_url: image === null ? previous?.thumbnail_url : decode_entities(image[1]!),
        });
    }
    return [...uploads.values()];
}

function channel_of(message: RawMessage): number | undefined {
    return message.type === "stream" ? message.stream_id : undefined;
}

export function rows_from_messages(messages: RawMessage[]): FileRow[] {
    const rows: FileRow[] = [];
    for (const message of messages) {
        const sender = people.maybe_get_user_by_id(message.sender_id, true);
        for (const upload of uploads_in_html(message.content)) {
            const path_id = path_id_of(upload.url);
            rows.push({
                key: `${message.id}:${path_id}`,
                message_id: message.id,
                name: upload.name,
                url: upload.url,
                path_id,
                kind: kind_of(upload.name),
                icon: KIND_ICONS[kind_of(upload.name)],
                thumbnail_url: upload.thumbnail_url,
                message_url: ykphone_activity.message_url(message),
                sender_id: message.sender_id,
                sender_name: message.sender_full_name,
                avatar_url:
                    sender === undefined
                        ? `/avatar/${message.sender_id}`
                        : people.small_avatar_url_for_person(sender),
                stream_id: channel_of(message),
                context_label: ykphone_activity.context_label(message),
                timestamp: message.timestamp,
                date_label: timerender.get_localized_date_or_time_for_format(
                    new Date(message.timestamp * 1000),
                    "dayofyear_year",
                ),
            });
        }
    }
    return rows;
}

// ---- The filter bar ----

export type FileFilters = {
    kind: FileKind | "any";
    sender_id: number | undefined;
    stream_id: number | undefined;
};

export const NO_FILE_FILTERS: FileFilters = {
    kind: "any",
    sender_id: undefined,
    stream_id: undefined,
};

export function filter_rows(rows: FileRow[], filters: FileFilters): FileRow[] {
    return rows.filter(
        (row) =>
            (filters.kind === "any" || row.kind === filters.kind) &&
            (filters.sender_id === undefined || row.sender_id === filters.sender_id) &&
            (filters.stream_id === undefined || row.stream_id === filters.stream_id),
    );
}

export type FilterOption = {value: string; label: string; selected: boolean};

// The values a filter can take are the ones the listed files have, so
// a dropdown never offers a choice that would empty the list.
export function kind_options(rows: FileRow[], filters: FileFilters): FilterOption[] {
    const present = new Set(rows.map((row) => row.kind));
    return [
        {
            value: "any",
            label: $t({defaultMessage: "All file types"}),
            selected: filters.kind === "any",
        },
        ...FILE_KINDS.filter((kind) => present.has(kind)).map((kind) => ({
            value: kind,
            label: kind_label(kind),
            selected: filters.kind === kind,
        })),
    ];
}

export function sender_options(rows: FileRow[], filters: FileFilters): FilterOption[] {
    const names = new Map<number, string>();
    for (const row of rows) {
        names.set(row.sender_id, row.sender_name);
    }
    return [
        {
            value: "",
            label: $t({defaultMessage: "Anyone"}),
            selected: filters.sender_id === undefined,
        },
        ...[...names.entries()]
            .toSorted((a, b) => a[1].localeCompare(b[1]))
            .map(([user_id, name]) => ({
                value: user_id.toString(),
                label: name,
                selected: filters.sender_id === user_id,
            })),
    ];
}

export function channel_options(rows: FileRow[], filters: FileFilters): FilterOption[] {
    const stream_ids = new Set<number>();
    for (const row of rows) {
        if (row.stream_id !== undefined) {
            stream_ids.add(row.stream_id);
        }
    }
    return [
        {
            value: "",
            label: $t({defaultMessage: "All channels"}),
            selected: filters.stream_id === undefined,
        },
        ...[...stream_ids]
            .map((stream_id) => ({
                stream_id,
                name: stream_data.get_sub_by_id(stream_id)?.name ?? stream_id.toString(),
            }))
            .toSorted((a, b) => a.name.localeCompare(b.name))
            .map(({stream_id, name}) => ({
                value: stream_id.toString(),
                label: `#${name}`,
                selected: filters.stream_id === stream_id,
            })),
    ];
}

// ---- The rows as the template reads them ----

export type FileRowContext = {
    key: string;
    message_id: number;
    // Where the row leads: the message the file was shared in.
    url: string;
    file_url: string;
    // The name as plain text (an aria-label), and the same name cut
    // into runs so the template can mark the searched words. Neither
    // is HTML: a file's name is whatever a poster wrote.
    name: string;
    name_runs: ykphone_highlight.HighlightRun[];
    icon: string;
    thumbnail_url: string | undefined;
    is_image: boolean;
    has_preview: boolean;
    sender_name: string;
    context_label: string;
    date_label: string;
    is_active: boolean;
};

// The name is marked here rather than by a function the caller hands
// in, so that no caller can pass one that does not escape: the rows
// leave as runs and the template renders each one with a double stash.
export function row_contexts(
    rows: FileRow[],
    opts: {
        hash_for?: ((row: FileRow) => string) | undefined;
        words?: string[] | undefined;
        selection?: string | undefined;
    } = {},
): FileRowContext[] {
    const words = opts.words ?? [];
    return rows.map((row) => ({
        key: row.key,
        message_id: row.message_id,
        url: opts.hash_for === undefined ? row.message_url : opts.hash_for(row),
        file_url: row.url,
        name: row.name,
        name_runs:
            words.length === 0
                ? ykphone_highlight.plain_runs(row.name)
                : ykphone_highlight.highlight_words(row.name, words),
        icon: row.icon,
        thumbnail_url: row.thumbnail_url,
        is_image: row.kind === "image",
        // An image with no preview of its own still gets a type icon.
        has_preview: row.kind === "image" && row.thumbnail_url !== undefined,
        sender_name: row.sender_name,
        context_label: row.context_label,
        date_label: row.date_label,
        is_active: opts.selection === row.message_id.toString(),
    }));
}

// The whole of the Files view's list, from the messages a
// "has:attachment" narrow brought back: the DOM side only renders it.
export function view_rows(messages: RawMessage[], filters: FileFilters): FileRowContext[] {
    return row_contexts(filter_rows(rows_from_messages(messages), filters));
}
