This directory contains icons used by the Zulip web app, primarily
sourced from Lucide Icons and Feather Icons (see `docs/THIRDPARTY).

Icons placed in this directory are compiled by the web application
build system into a custom icon font. You can use them in HTML using
the following syntax:

`<i class="zulip-icon zulip-icon-more-vertical">`

It is critical that icons from third parties be listed with appropriate
attribution in the `docs/THIRDPARTY` file. To make it easier to audit
that file in the future, below is a list of custom icons created in-house
for the Zulip project:

arrow-down.svg
bell.svg
bold.svg
bookmark-filled.svg
bookmark.svg
bot.svg
browse-channels.svg
compose-scroll-left.svg
compose-scroll-right.svg
dm-groups-3.svg
exclamation-circle.svg
gif.svg
hashtag.svg
heading-triangle-right.svg
help-bigger.svg
help.svg
keyboard.svg
line-height-big.svg
link.svg
manage-search.svg
masked-unread.svg
math.svg
ordered-list.svg
panel-left-dashed.svg
panel-left.svg
pin.svg
placeholder.svg
question.svg
quote-message.svg
quote.svg
search-inbox.svg
send.svg
sort-arrow-down.svg
spoiler.svg
strikethrough.svg
topic-list.svg
topic.svg
type-big.svg
unordered-list.svg
unpin.svg
unread.svg
user-circle-active.svg
user-circle-deactivated.svg
user-circle-idle.svg
user-circle-offline.svg
ykphone-rail-bell.svg
ykphone-rail-bell-filled.svg
ykphone-rail-dm.svg
ykphone-rail-dm-filled.svg
ykphone-rail-file.svg
ykphone-rail-file-filled.svg
ykphone-rail-gear.svg
ykphone-rail-gear-filled.svg
ykphone-rail-house.svg
ykphone-rail-house-filled.svg

The `ykphone-rail-*` icons are the 옆커폰 fork's rail set (home, direct
messages, activity, files, admin), drawn in-house on a 24px grid with a
1.75px round-capped stroke and soft corners, and traced to filled
outlines for the icon font; the `-filled` variants are the same
silhouettes filled. The rail renders both glyphs of an item and the
theme shows the filled one while the item is active.
