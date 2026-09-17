"use strict";

const assert = require("node:assert/strict");

const {zrequire} = require("./lib/namespace.cjs");
const {run_test} = require("./lib/test.cjs");

const ykphone_highlight = zrequire("ykphone_highlight");

function shape(runs) {
    return runs.map((run) => (run.matched ? `<${run.text}>` : run.text)).join("");
}

run_test("plain_text", () => {
    assert.equal(
        ykphone_highlight.plain_text("<p>Hello <strong>world</strong></p><p>second</p>"),
        "Hello world second ",
    );
    assert.equal(ykphone_highlight.plain_text("line one<br>line two"), "line one line two");
    assert.equal(
        ykphone_highlight.plain_text(
            "<p>&lt;a&gt; &amp; &#39;q&#39; &#x41;&#X42; &nbsp;x &zzz;</p>",
        ),
        "<a> & 'q' AB x &zzz; ",
    );
    // Whitespace is collapsed but not trimmed: the pieces a
    // highlighted message is cut into are joined afterwards.
    assert.equal(ykphone_highlight.plain_text("  a   b  "), " a b ");
});

run_test("runs", () => {
    assert.deepEqual(ykphone_highlight.plain_runs(""), []);
    assert.deepEqual(ykphone_highlight.plain_runs("abc"), [{text: "abc", matched: false}]);
    assert.deepEqual(ykphone_highlight.runs_from_marks("", []), []);
    assert.deepEqual(ykphone_highlight.runs_from_marks("ab", [true, true]), [
        {text: "ab", matched: true},
    ]);
});

run_test("highlight_words", () => {
    assert.deepEqual(ykphone_highlight.highlight_words("보고서.pdf", []), [
        {text: "보고서.pdf", matched: false},
    ]);
    assert.equal(shape(ykphone_highlight.highlight_words("보고서.pdf", ["보고"])), "<보고>서.pdf");
    // Case-insensitive, every occurrence, and a word that is not there
    // marks nothing.
    assert.equal(shape(ykphone_highlight.highlight_words("Plan A", ["a"])), "Pl<a>n <A>");
    assert.equal(shape(ykphone_highlight.highlight_words("nothing", ["zzz"])), "nothing");
    assert.equal(shape(ykphone_highlight.highlight_words("nothing", [""])), "nothing");

    // A name with an emoji in it is marked where the match really is:
    // an astral character is two UTF-16 code units, and the offsets
    // and the slicing agree about that.
    assert.equal(
        shape(ykphone_highlight.highlight_words("🎉 budget report", ["budget"])),
        "🎉 <budget> report",
    );
    assert.equal(shape(ykphone_highlight.highlight_words("🎉🎉 예산", ["예산"])), "🎉🎉 <예산>");

    // A character that grows when it is lower-cased would move every
    // offset after it; such a name is matched as it is written.
    assert.equal(shape(ykphone_highlight.highlight_words("İstanbul", ["stan"])), "İ<stan>bul");
    assert.equal(shape(ykphone_highlight.highlight_words("İstanbul", ["STAN"])), "İstanbul");
});
