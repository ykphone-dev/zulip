import $ from "jquery";
import * as z from "zod/mini";

import {$t} from "./i18n.ts";

// The colour themes of the shell (icon rail, navbar and sidebar), as
// Slack offers them on top of light and dark. A theme is only a set of
// colour tokens in web/styles/ykphone_theme.css, applied by the
// data-yk-theme attribute of <html>; the server writes the user's
// theme there when it renders the page, so it is in place before the
// first paint and this module only has to change it afterwards.

export const DEFAULT_SHELL_THEME = "ykphone";

export type ShellTheme = {
    id: string;
    name: string;
};

// In the order the picker shows them. Keep the ids in sync with
// SHELL_THEMES in ykphone/lib/preferences.py and with the
// [data-yk-theme] blocks of the stylesheet; a backend test compares all
// three.
export function get_shell_themes(): ShellTheme[] {
    return [
        {
            id: "ykphone",
            name: $t({defaultMessage: "Yeopkerphone"}),
        },
        {
            id: "navy",
            name: $t({defaultMessage: "Navy"}),
        },
        {
            id: "graphite",
            name: $t({defaultMessage: "Graphite"}),
        },
        {
            id: "forest",
            name: $t({defaultMessage: "Forest"}),
        },
        {
            id: "burgundy",
            name: $t({defaultMessage: "Burgundy"}),
        },
        {
            id: "ocean",
            name: $t({defaultMessage: "Ocean"}),
        },
        {
            id: "sand",
            name: $t({defaultMessage: "Sand"}),
        },
        {
            id: "midnight",
            name: $t({defaultMessage: "Midnight"}),
        },
    ];
}

export function is_shell_theme(id: string): boolean {
    return get_shell_themes().some((theme) => theme.id === id);
}

export function current_shell_theme(): string {
    const id = $(":root").attr("data-yk-theme");
    if (id === undefined || !is_shell_theme(id)) {
        return DEFAULT_SHELL_THEME;
    }
    return id;
}

export function apply_shell_theme(id: string): void {
    $(":root").attr("data-yk-theme", id);
    // The picker in settings, when it has been rendered, follows changes
    // made elsewhere (another tab, a failed save).
    $(`input.ykphone-theme-swatch-input[value='${id}']`).prop("checked", true);
}

export type ShellThemePickerContext = {
    themes: (ShellTheme & {is_active: boolean})[];
};

export function picker_context(): ShellThemePickerContext {
    const current = current_shell_theme();
    return {
        themes: get_shell_themes().map((theme) => ({...theme, is_active: theme.id === current})),
    };
}

const preference_event_schema = z.object({
    type: z.literal("ykphone_preference"),
    property: z.literal("shell_theme"),
    value: z.string(),
});

export function handle_event(raw_event: unknown): void {
    const event = preference_event_schema.parse(raw_event);
    // A theme this client does not know yet (a newer server) shows as
    // the default until the page is reloaded with the new code.
    apply_shell_theme(is_shell_theme(event.value) ? event.value : DEFAULT_SHELL_THEME);
}
