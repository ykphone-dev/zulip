import $ from "jquery";
import assert from "minimalistic-assert";

import * as compose_actions from "./compose_actions.ts";
import * as message_store from "./message_store.ts";
import * as message_view from "./message_view.ts";
import * as rows from "./rows.ts";
import * as ykphone_flags from "./ykphone_flags.ts";
import * as ykphone_threads from "./ykphone_threads.ts";
import type {ThreadInfo} from "./ykphone_threads.ts";

function go_to_thread(thread: ThreadInfo, start_reply: boolean): void {
    message_view.show(
        [
            {operator: "channel", operand: thread.stream_id.toString()},
            {operator: "topic", operand: thread.topic_name},
        ],
        {trigger: "ykphone thread", change_hash: true},
    );
    if (start_reply) {
        compose_actions.start({
            message_type: "stream",
            stream_id: thread.stream_id,
            topic: thread.topic_name,
            trigger: "ykphone thread",
            is_reply: true,
        });
    }
}

export function open_thread_for_message(message_id: number): void {
    const message = message_store.get(message_id);
    assert(message !== undefined && message.type === "stream");
    ykphone_threads.create_thread(message_id, (thread) => {
        go_to_thread(thread, true);
    });
}

export function initialize(): void {
    ykphone_flags.set_channels_open_in_general_chat(true);

    $("body").on("click", ".ykphone-thread-button", (e) => {
        e.stopPropagation();
        e.preventDefault();
        const $row = rows.get_closest_row($(e.currentTarget));
        open_thread_for_message(rows.id($row));
    });

    $("body").on("click", ".ykphone-thread-pill", (e) => {
        e.stopPropagation();
        e.preventDefault();
        const $row = rows.get_closest_row($(e.currentTarget));
        const thread = ykphone_threads.get_thread(rows.id($row));
        assert(thread !== undefined);
        go_to_thread(thread, false);
    });
}
