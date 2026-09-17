import assert from "minimalistic-assert";

import * as channel from "./channel.ts";
import * as settings_ui from "./settings_ui.ts";
import type {RequestOpts} from "./settings_ui.ts";
import type {StreamProperties, StreamSubscription} from "./sub_store.ts";
import * as sub_store from "./sub_store.ts";

export type SubData = {
    [Property in keyof StreamProperties]: {
        stream_id: number;
        property: Property;
        value: StreamProperties[Property];
    };
}[keyof StreamProperties][];

export function bulk_set_stream_property(
    sub_data: SubData,
    $status_element?: JQuery,
    // Callers that need to hear about a refusal (the fork's channel
    // details dialog puts its controls back) pass settings_ui's own
    // options through.
    opts?: RequestOpts,
): void {
    const url = "/json/users/me/subscriptions/properties";
    const data = {subscription_data: JSON.stringify(sub_data)};
    if (!$status_element) {
        return void channel.post({
            url,
            data,
            timeout: 10 * 1000,
        });
    }

    settings_ui.do_settings_change(channel.post, url, data, $status_element, opts);
    return undefined;
}

export function set_stream_property(
    sub: StreamSubscription,
    data: {
        [Property in keyof StreamProperties]: {
            property: Property;
            value: StreamProperties[Property];
        };
    }[keyof StreamProperties],
    $status_element?: JQuery,
    opts?: RequestOpts,
): void {
    const sub_data = {stream_id: sub.stream_id, ...data};
    bulk_set_stream_property([sub_data], $status_element, opts);
}

export function set_color(stream_id: number, color: string): void {
    const sub = sub_store.get(stream_id);
    assert(sub !== undefined);
    set_stream_property(sub, {property: "color", value: color});
}
