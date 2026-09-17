// Text the 옆커폰 fork shows with some of its words marked: a search
// result's line, a file's name, a channel or a person the search
// matched.
//
// The marked text never leaves this module as HTML. It leaves as
// *runs* — pieces of plain text, each either matched or not — which
// the templates render through ykphone_highlighted_text.hbs, so every
// character a message, a file name or a channel description carries is
// escaped by Handlebars like any other value. Nothing in a row is
// rendered with a triple-stash.

export type HighlightRun = {
    text: string;
    matched: boolean;
};

const named_entities: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
};

// The text of rendered message HTML, with the tags taken out and the
// entities decoded. Whitespace is collapsed but not trimmed, so that
// pieces flattened separately (the parts of a highlighted message) can
// be joined without losing the space between them.
export function plain_text(html: string): string {
    return (
        html
            // Block boundaries and line breaks become spaces so words
            // from neighbouring paragraphs do not run together.
            .replaceAll(/<br\s*\/?>|<\/(?:p|div|li|h[1-6]|blockquote|pre|tr|td|th)>/gi, " ")
            .replaceAll(/<[^>]*>/g, "")
            .replaceAll(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity: string, code: string): string => {
                if (code.startsWith("#x") || code.startsWith("#X")) {
                    return String.fromCodePoint(Number.parseInt(code.slice(2), 16));
                }
                if (code.startsWith("#")) {
                    return String.fromCodePoint(Number.parseInt(code.slice(1), 10));
                }
                return named_entities[code.toLowerCase()] ?? entity;
            })
            .replaceAll(/\s+/g, " ")
    );
}

// Runs from a text and a mark per UTF-16 code unit. The text is only
// ever sliced at code-unit offsets that came from indexOf or from a
// length, so a surrogate pair is never cut in half, and a name with an
// emoji in it is marked where the match really is.
export function runs_from_marks(text: string, marks: boolean[]): HighlightRun[] {
    const runs: HighlightRun[] = [];
    let start = 0;
    for (let index = 1; index <= text.length; index += 1) {
        if (index === text.length || marks[index] !== marks[start]) {
            runs.push({text: text.slice(start, index), matched: marks[start] === true});
            start = index;
        }
    }
    return runs;
}

// One unmarked run, for text nothing was searched for in.
export function plain_runs(text: string): HighlightRun[] {
    return text === "" ? [] : [{text, matched: false}];
}

// A name or a description with the query's own words marked (the
// Files, Channels and People tabs have no server highlighting).
export function highlight_words(text: string, words: string[]): HighlightRun[] {
    const marks: boolean[] = Array.from({length: text.length}, () => false);
    const lowered = text.toLowerCase();
    // A few characters grow when they are lower-cased ("İ"), which
    // would move every offset after them; such a name is matched as it
    // is written rather than marked in the wrong place.
    const folds = lowered.length === text.length;
    const haystack = folds ? lowered : text;
    for (const word of words) {
        const needle = folds ? word.toLowerCase() : word;
        if (needle === "") {
            continue;
        }
        let index = haystack.indexOf(needle);
        while (index !== -1) {
            for (let offset = 0; offset < needle.length; offset += 1) {
                marks[index + offset] = true;
            }
            index = haystack.indexOf(needle, index + needle.length);
        }
    }
    return runs_from_marks(text, marks);
}
