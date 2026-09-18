"use strict";

const assert = require("node:assert/strict");

const render_file_rows = require("../templates/ykphone_file_rows.hbs");

const {make_user} = require("./lib/example_user.cjs");
const {mock_esm, zrequire} = require("./lib/namespace.cjs");
const {run_test} = require("./lib/test.cjs");

const me = make_user({user_id: 5});
const verona_id = 3;
const devel_id = 4;

mock_esm("../src/people", {
    maybe_get_user_by_id: (user_id) => (user_id === 7 ? {user_id: 7} : undefined),
    small_avatar_url_for_person: (person) => `/avatar/${person.user_id}/small`,
    sorted_other_user_ids: (user_ids) => user_ids.filter((user_id) => user_id !== me.user_id),
});
mock_esm("../src/stream_data", {
    get_sub_by_id(stream_id) {
        if (stream_id === verona_id) {
            return {name: "Verona"};
        }
        return stream_id === devel_id ? {name: "devel"} : undefined;
    },
});
mock_esm("../src/timerender", {
    get_localized_date_or_time_for_format: (date) => `date:${date.getTime() / 1000}`,
});
mock_esm("../src/hash_util", {
    search_terms_to_hash: (terms) =>
        "#narrow/" + terms.map((term) => `${term.operator}/${term.operand}`).join("/"),
});

const {set_current_user} = zrequire("state_data");
const ykphone_files = zrequire("ykphone_files");

set_current_user(me);

function raw_message(id, opts = {}) {
    return {
        id,
        avatar_url: null,
        client: "website",
        content: "<p>hi</p>",
        content_type: "text/html",
        is_me_message: false,
        reactions: [],
        sender_email: "hamlet@zulip.com",
        sender_full_name: "Hamlet",
        sender_id: 7,
        submessages: [],
        timestamp: 1_700_000_000 + id,
        flags: [],
        type: "stream",
        stream_id: verona_id,
        display_recipient: "Verona",
        subject: "",
        topic_links: [],
        ...opts,
    };
}

run_test("file kinds", () => {
    assert.equal(ykphone_files.extension_of("notes.TXT"), "txt");
    assert.equal(ykphone_files.extension_of("archive.tar.gz"), "gz");
    assert.equal(ykphone_files.extension_of("cat.png?x=1"), "png");
    assert.equal(ykphone_files.extension_of("README"), "");

    assert.equal(ykphone_files.kind_of("cat.png"), "image");
    assert.equal(ykphone_files.kind_of("clip.mp4"), "video");
    assert.equal(ykphone_files.kind_of("song.mp3"), "audio");
    assert.equal(ykphone_files.kind_of("plan.hwp"), "document");
    assert.equal(ykphone_files.kind_of("bundle.zip"), "archive");
    assert.equal(ykphone_files.kind_of("program.exe"), "other");

    assert.ok(ykphone_files.is_file_kind("image"));
    assert.ok(!ykphone_files.is_file_kind("anything"));

    assert.deepEqual(
        ykphone_files.FILE_KINDS.map((kind) => ykphone_files.kind_label(kind)),
        [
            "translated: Images",
            "translated: Videos",
            "translated: Audio",
            "translated: Documents",
            "translated: Archives",
            "translated: Other files",
        ],
    );
});

run_test("path_id_of", () => {
    assert.equal(ykphone_files.path_id_of("/user_uploads/2/ab/cd/notes.txt"), "2/ab/cd/notes.txt");
    // Something that is not an upload keeps its whole URL as its key.
    assert.equal(ykphone_files.path_id_of("https://example.com/x"), "https://example.com/x");
});

run_test("uploads in a rendered message", () => {
    // A plain upload: the link's text is the file's name.
    assert.deepEqual(
        ykphone_files.uploads_in_html(
            '<p><a href="/user_uploads/2/ab/notes.txt">notes.txt</a></p>',
        ),
        [{url: "/user_uploads/2/ab/notes.txt", name: "notes.txt", thumbnail_url: undefined}],
    );

    // An image: Zulip renders the link and a preview of the same file,
    // and the preview's thumbnail is what the row shows.
    const image_html =
        '<p><a href="/user_uploads/2/ab/cat%20photo.png">cat photo.png</a></p>' +
        '<div class="message_inline_image">' +
        '<a href="/user_uploads/2/ab/cat%20photo.png" title="cat photo.png">' +
        '<img src="/user_uploads/thumbnail/2/ab/cat%20photo.png/840x560.webp"></a></div>';
    assert.deepEqual(ykphone_files.uploads_in_html(image_html), [
        {
            url: "/user_uploads/2/ab/cat%20photo.png",
            name: "cat photo.png",
            thumbnail_url: "/user_uploads/thumbnail/2/ab/cat%20photo.png/840x560.webp",
        },
    ]);

    // The preview alone: the name comes from the file's own path.
    assert.deepEqual(
        ykphone_files.uploads_in_html(
            '<div class="message_inline_image"><a href="/user_uploads/2/ab/plan.pdf">' +
                '<img src="/thumb.webp"></a></div>',
        ),
        [{url: "/user_uploads/2/ab/plan.pdf", name: "plan.pdf", thumbnail_url: "/thumb.webp"}],
    );

    // A link with no text at all, an escaped query, and a link that is
    // not an upload.
    assert.deepEqual(
        ykphone_files.uploads_in_html(
            '<a href="/user_uploads/2/ab/a%2Fb.txt?x=1&amp;y=2"></a>' +
                '<a href="https://example.com/other.png">other</a>',
        ),
        [
            {
                url: "/user_uploads/2/ab/a%2Fb.txt?x=1&y=2",
                name: "a/b.txt",
                thumbnail_url: undefined,
            },
        ],
    );

    // A name that is not valid percent-encoding is taken as it stands.
    assert.deepEqual(
        ykphone_files.uploads_in_html('<a href="/user_uploads/2/ab/100%.txt"><img src="/t"></a>'),
        [{url: "/user_uploads/2/ab/100%.txt", name: "100%.txt", thumbnail_url: "/t"}],
    );

    assert.deepEqual(ykphone_files.uploads_in_html("<p>no files here</p>"), []);

    // A link whose text is escaped markup: the name is the text a
    // reader sees, which is not markup and is never treated as any.
    assert.deepEqual(
        ykphone_files.uploads_in_html(
            '<p><a href="/user_uploads/2/ab/note.txt">&lt;img src=x onerror=alert(1)&gt;</a></p>',
        ),
        [
            {
                url: "/user_uploads/2/ab/note.txt",
                name: "<img src=x onerror=alert(1)>",
                thumbnail_url: undefined,
            },
        ],
    );

    // A percent-encoded "<" in the path of an upload URL: the name is
    // decoded from the path and is, again, only ever text.
    assert.deepEqual(
        ykphone_files.uploads_in_html(
            '<div class="message_inline_image">' +
                '<a href="https://evil.example/user_uploads/%3Cimg%20src=x%20onerror=alert(1)%3E.png">' +
                '<img src="/thumb.webp"></a></div>',
        ),
        [
            {
                url: "https://evil.example/user_uploads/%3Cimg%20src=x%20onerror=alert(1)%3E.png",
                name: "<img src=x onerror=alert(1)>.png",
                thumbnail_url: "/thumb.webp",
            },
        ],
    );

    // Only a link whose *path* is an upload counts; one that merely
    // mentions the word is not a file.
    assert.deepEqual(
        ykphone_files.uploads_in_html(
            '<a href="https://evil.example/x?next=/user_uploads/2/ab/note.txt">click</a>',
        ),
        [],
    );
});

function messages_with_files() {
    return [
        raw_message(10, {
            content: '<p><a href="/user_uploads/2/ab/notes.txt">notes.txt</a></p>',
        }),
        raw_message(11, {
            stream_id: devel_id,
            display_recipient: "devel",
            subject: "Plans",
            sender_id: 9,
            sender_full_name: "Zoe",
            content: '<p><a href="/user_uploads/2/cd/cat.png">cat.png</a></p>',
        }),
        raw_message(12, {
            type: "private",
            display_recipient: [
                {id: me.user_id, email: "me@zulip.com", full_name: "Me"},
                {id: 7, email: "hamlet@zulip.com", full_name: "Hamlet"},
            ],
            content: '<p><a href="/user_uploads/2/ef/bundle.zip">bundle.zip</a></p>',
        }),
    ];
}

run_test("rows from messages", () => {
    const rows = ykphone_files.rows_from_messages(messages_with_files());
    assert.deepEqual(
        rows.map((row) => [row.key, row.name, row.kind, row.icon, row.context_label]),
        [
            ["10:2/ab/notes.txt", "notes.txt", "document", "file-text", "#Verona"],
            ["11:2/cd/cat.png", "cat.png", "image", "mobile-image", "translated: #devel thread"],
            ["12:2/ef/bundle.zip", "bundle.zip", "archive", "archive", "translated: DM"],
        ],
    );
    // The sender's avatar comes from the store, and from the server by
    // user id for somebody the client does not know.
    assert.equal(rows[0].avatar_url, "/avatar/7/small");
    assert.equal(rows[1].avatar_url, "/avatar/9");
    assert.deepEqual(
        rows.map((row) => row.stream_id),
        [verona_id, devel_id, undefined],
    );
    assert.equal(rows[0].date_label, `date:${1_700_000_010}`);

    // A message with no file at all contributes no row.
    assert.deepEqual(ykphone_files.rows_from_messages([raw_message(13)]), []);
});

run_test("filters", () => {
    const rows = ykphone_files.rows_from_messages(messages_with_files());
    const names = (filters) => ykphone_files.filter_rows(rows, filters).map((row) => row.name);

    assert.deepEqual(names(ykphone_files.NO_FILE_FILTERS), ["notes.txt", "cat.png", "bundle.zip"]);
    assert.deepEqual(names({...ykphone_files.NO_FILE_FILTERS, kind: "image"}), ["cat.png"]);
    assert.deepEqual(names({...ykphone_files.NO_FILE_FILTERS, sender_id: 9}), ["cat.png"]);
    assert.deepEqual(names({...ykphone_files.NO_FILE_FILTERS, stream_id: verona_id}), [
        "notes.txt",
    ]);
});

run_test("filter options", () => {
    const rows = ykphone_files.rows_from_messages(messages_with_files());

    // Only the types the listed files have are offered.
    assert.deepEqual(
        ykphone_files.kind_options(rows, {...ykphone_files.NO_FILE_FILTERS, kind: "image"}),
        [
            {value: "any", label: "translated: All file types", selected: false},
            {value: "image", label: "translated: Images", selected: true},
            {value: "document", label: "translated: Documents", selected: false},
            {value: "archive", label: "translated: Archives", selected: false},
        ],
    );

    assert.deepEqual(
        ykphone_files.sender_options(rows, {...ykphone_files.NO_FILE_FILTERS, sender_id: 9}),
        [
            {value: "", label: "translated: Anyone", selected: false},
            {value: "7", label: "Hamlet", selected: false},
            {value: "9", label: "Zoe", selected: true},
        ],
    );

    // Direct messages are in no channel, so they add no choice; a
    // channel the client no longer knows is named by its id.
    const with_unknown = [
        ...rows,
        ...ykphone_files.rows_from_messages([
            raw_message(14, {
                stream_id: 99,
                display_recipient: "Gone",
                content: '<p><a href="/user_uploads/2/gh/old.txt">old.txt</a></p>',
            }),
        ]),
    ];
    assert.deepEqual(
        ykphone_files.channel_options(with_unknown, {
            ...ykphone_files.NO_FILE_FILTERS,
            stream_id: devel_id,
        }),
        [
            {value: "", label: "translated: All channels", selected: false},
            {value: "99", label: "#99", selected: false},
            {value: String(devel_id), label: "#devel", selected: true},
            {value: String(verona_id), label: "#Verona", selected: false},
        ],
    );
});

run_test("row contexts", () => {
    const rows = ykphone_files.rows_from_messages(messages_with_files());
    const contexts = ykphone_files.row_contexts(rows, {
        hash_for: (row) => `#message/${row.message_id}`,
        words: ["cat"],
        selection: "11",
    });
    assert.deepEqual(
        contexts.map((context) => [context.url, context.is_image, context.is_active]),
        [
            ["#message/10", false, false],
            ["#message/11", true, true],
            ["#message/12", false, false],
        ],
    );
    assert.equal(contexts[0].file_url, "/user_uploads/2/ab/notes.txt");
    // The name is runs of plain text, with the searched words marked.
    assert.deepEqual(contexts[1].name_runs, [
        {text: "cat", matched: true},
        {text: ".png", matched: false},
    ]);
    assert.deepEqual(contexts[0].name_runs, [{text: "notes.txt", matched: false}]);
    assert.equal(contexts[0].name, "notes.txt");

    // Without a selection no row is the active one, and without a
    // search nothing is marked; the row still leads to its message.
    const plain = ykphone_files.row_contexts(rows);
    assert.ok(plain.every((context) => !context.is_active));
    assert.deepEqual(plain[0].name_runs, [{text: "notes.txt", matched: false}]);
    assert.equal(plain[0].url, "#narrow/channel/3/topic//near/10");

    // An image with no preview of its own keeps a type icon.
    const no_preview = ykphone_files.row_contexts(
        ykphone_files.rows_from_messages([
            raw_message(20, {
                content: '<p><a href="/user_uploads/2/ab/cat.png">cat.png</a></p>',
            }),
        ]),
    );
    assert.equal(no_preview[0].is_image, true);
    assert.equal(no_preview[0].has_preview, false);
});

run_test("view_rows is the whole list the Files view draws", () => {
    const rows = ykphone_files.view_rows(messages_with_files(), {
        ...ykphone_files.NO_FILE_FILTERS,
        kind: "image",
    });
    assert.deepEqual(
        rows.map((row) => [row.name, row.url]),
        [["cat.png", "#narrow/channel/4/topic/Plans/near/11"]],
    );
    assert.deepEqual(ykphone_files.view_rows([], ykphone_files.NO_FILE_FILTERS), []);
});

// The two vectors from the round-16 review: a poster chooses both a
// link's words and its path, so both reach the row as text.
run_test("a file name is never markup", () => {
    const vectors = [
        // [<img src=x onerror=alert(1)>](/user_uploads/…) as Zulip
        // renders it.
        '<p><a href="/user_uploads/2/ab/note.txt">&lt;img src=x onerror=alert(1)&gt;</a></p>',
        // ![x](https://…/user_uploads/%3Cimg…%3E.png) as Zulip renders
        // it.
        '<div class="message_inline_image">' +
            '<a href="/user_uploads/2/ab/%3Cimg%20src=x%20onerror=alert(1)%3E.png">' +
            '<img src="/thumb.webp"></a></div>',
    ];
    for (const content of vectors) {
        const rows = ykphone_files.view_rows(
            [raw_message(30, {content})],
            ykphone_files.NO_FILE_FILTERS,
        );
        assert.equal(rows.length, 1);
        const html = render_file_rows({
            loading: false,
            error: false,
            has_rows: true,
            empty_label: "",
            rows,
        });
        // Handlebars escapes "<", ">" and "=" in the name, so no
        // element and no attribute of the poster's survives: the only
        // <img> in the list is the fork's own thumbnail.
        const images = [...html.matchAll(/<img\b[^>]*>/g)].map((match) => match[0]);
        assert.ok(
            images.every((tag) => tag.includes('class="ykphone-file-thumbnail"')),
            images.join(" "),
        );
        // The name's "=" is escaped too, so "onerror" can never be
        // an attribute.
        assert.ok(!html.includes("onerror="), html);
        assert.ok(html.includes("&lt;img src&#x3D;x onerror&#x3D;alert(1)&gt;"), html);
        // What the reader sees is the name as it was written.
        assert.ok(rows[0].name.startsWith("<img src=x onerror=alert(1)>"), rows[0].name);
    }
});

// A channel's or a person's name is marked the same way, and a name
// that is markup comes out as text.
run_test("a marked name is never markup either", () => {
    const rows = ykphone_files.view_rows(
        [
            raw_message(40, {
                content:
                    '<p><a href="/user_uploads/2/ab/x.txt">&lt;b&gt;bold&lt;/b&gt;.txt</a></p>',
            }),
        ],
        ykphone_files.NO_FILE_FILTERS,
    );
    const marked = ykphone_files.row_contexts(
        ykphone_files.rows_from_messages([
            raw_message(41, {
                content:
                    '<p><a href="/user_uploads/2/ab/y.txt">&lt;b&gt;bold&lt;/b&gt;.txt</a></p>',
            }),
        ]),
        {words: ["bold"]},
    );
    const html = render_file_rows({
        loading: false,
        error: false,
        has_rows: true,
        empty_label: "",
        rows: [...rows, ...marked],
    });
    assert.ok(!html.includes("<b>bold</b>"), html);
    assert.ok(html.includes("&lt;b&gt;bold&lt;/b&gt;.txt"), html);
    assert.ok(!html.includes("&lt;b&gt;bold&lt;/b&gt;.txt\n"), "no stray newline inside a name");
    assert.ok(
        html.includes('<span class="ykphone-search-highlight">bold</span>'),
        "the searched word is the only markup the name carries",
    );
});
