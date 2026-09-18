"""Slack's Later list for the 옆커폰 fork: saved messages with a state
and an optional due date, kept in step with Zulip's star flag.

The rule is that a message is starred exactly while its item is in
progress or completed:

* starring a message (from any client) adds an item in progress, or
  brings an archived one back;
* unstarring it removes the item, unless the item is archived;
* the fork's API changes an item's state and due date without touching
  the star, except that archiving unstars the message and taking an
  item out of the archive stars it again;
* removing an item unstars the message.

A change made through the fork's API is sent to the user as a
``ykphone_saved`` event; a change the star made is announced by
Zulip's own update_message_flags event (see sync_saved_items_with_star).
"""

from datetime import datetime
from typing import TypedDict

from django.db import transaction
from django.utils.translation import gettext as _

from ykphone.models import SavedItem
from zerver.lib.exceptions import JsonableError
from zerver.lib.message import access_message, bulk_access_messages, get_starred_message_ids
from zerver.lib.timestamp import datetime_to_timestamp, timestamp_to_datetime
from zerver.models import UserProfile
from zerver.tornado.django_api import send_event_on_commit

# Slack's Later list is a working list; older items are reached through
# search, as upstream's starred view caps the ids it sends at 10000.
MAX_SAVED_ITEMS_LISTED = 500


class SavedDict(TypedDict):
    message_id: int
    state: str
    # Seconds since the epoch, or None when no due date is set.
    due: int | None
    date_created: int


def saved_dict(item: SavedItem) -> SavedDict:
    return SavedDict(
        message_id=item.message_id,
        state=item.state,
        due=None if item.due is None else datetime_to_timestamp(item.due),
        date_created=datetime_to_timestamp(item.date_created),
    )


def send_saved_event(user_profile: UserProfile, op: str, item: SavedItem) -> None:
    send_event_on_commit(
        user_profile.realm,
        {"type": "ykphone_saved", "op": op, "item": saved_dict(item)},
        [user_profile.id],
    )


def check_state(state: str) -> str:
    if state not in SavedItem.STATES:
        raise JsonableError(_("Invalid state: {state}").format(state=state))
    return state


def set_star(user_profile: UserProfile, message_id: int, starred: bool) -> None:
    # Imported here: zerver.actions.message_flags calls
    # sync_saved_items_with_star below, so a module-level import would
    # be circular.
    from zerver.actions.message_flags import do_update_message_flags

    do_update_message_flags(user_profile, "add" if starred else "remove", "starred", [message_id])


def sync_saved_items_with_star(
    user_profile: UserProfile, message_ids: list[int], starred: bool
) -> None:
    """Called by do_update_message_flags, inside its transaction, with
    the messages whose star flag it has just changed; a constant number
    of queries however many messages ("unstar all" sends thousands).

    No event of the fork's is sent: the web app applies the same rule
    to Zulip's own update_message_flags event, which every client of
    the user receives, so the star and the item never tell a client
    two different stories (and Zulip's event tests see one event)."""
    if len(message_ids) == 0:
        return
    items = SavedItem.objects.filter(user=user_profile, message_id__in=message_ids)
    if starred:
        SavedItem.objects.bulk_create(
            [SavedItem(user=user_profile, message_id=message_id) for message_id in message_ids],
            ignore_conflicts=True,
        )
        items.filter(state=SavedItem.ARCHIVED).update(state=SavedItem.IN_PROGRESS)
    else:
        items.exclude(state=SavedItem.ARCHIVED).delete()


class SavedList(TypedDict):
    items: list[SavedDict]
    # Every readable item in progress, however many are listed.
    in_progress_count: int


def readable_ids(user_profile: UserProfile, items: list[SavedItem]) -> set[int]:
    return {
        message.id
        for message in bulk_access_messages(
            user_profile, [item.message for item in items], is_modifying_message=False
        )
    }


def saved_items(user_profile: UserProfile) -> SavedList:
    """The user's items, newest saved first, at most
    MAX_SAVED_ITEMS_LISTED in each state, and the number in progress.

    An item whose message the user can no longer read (moved to a
    private channel with protected history, a private channel the user
    left) is deleted here, as the star goes with the message in the
    first case; the list is where access is checked, so a lost message
    never takes a place in the list or the count. Stars the sync never
    saw (messages starred before the fork's table existed, the welcome
    messages a new account starts with) get their item here too."""
    starred_ids = set(get_starred_message_ids(user_profile))
    known_ids = set(
        SavedItem.objects.filter(user=user_profile, message_id__in=starred_ids).values_list(
            "message_id", flat=True
        )
    )
    missing_ids = starred_ids - known_ids
    if len(missing_ids) > 0:
        SavedItem.objects.bulk_create(
            [SavedItem(user=user_profile, message_id=message_id) for message_id in missing_ids],
            ignore_conflicts=True,
        )

    listed: list[SavedDict] = []
    in_progress_count = 0
    for state in SavedItem.STATES:
        items = SavedItem.objects.filter(user=user_profile, state=state).select_related(
            "message", "message__recipient"
        )
        # Starred items (in progress, completed) are bounded by Zulip's
        # own starred ids and are all checked, so the count is exact;
        # the archive, which only grows, is read newest first until the
        # list is full.
        chunk_size = 10000 if state != SavedItem.ARCHIVED else MAX_SAVED_ITEMS_LISTED
        offset = 0
        in_state: list[SavedItem] = []
        while True:
            chunk = list(
                items.order_by("-date_created", "-message_id")[offset : offset + chunk_size]
            )
            if len(chunk) == 0:
                break
            readable = readable_ids(user_profile, chunk)
            lost = [item.id for item in chunk if item.message_id not in readable]
            if len(lost) > 0:
                SavedItem.objects.filter(id__in=lost).delete()
            in_state.extend(item for item in chunk if item.message_id in readable)
            offset += len(chunk) - len(lost)
            if len(chunk) < chunk_size or (
                state == SavedItem.ARCHIVED and len(in_state) >= MAX_SAVED_ITEMS_LISTED
            ):
                break
        if state == SavedItem.IN_PROGRESS:
            in_progress_count = len(in_state)
        listed.extend(saved_dict(item) for item in in_state[:MAX_SAVED_ITEMS_LISTED])
    return SavedList(items=listed, in_progress_count=in_progress_count)


def get_saved_item(user_profile: UserProfile, message_id: int) -> SavedItem:
    item = SavedItem.objects.select_for_update(no_key=True).filter(
        user=user_profile, message_id=message_id
    )
    found = item.first()
    if found is None:
        raise JsonableError(_("This message is not saved."))
    return found


# The last second of the year 9999: a later time cannot be stored, and a
# larger number is most likely milliseconds sent by mistake.
MAX_DUE_TIMESTAMP = 253402300799


def check_due(due: int | None) -> datetime | None:
    if due is None:
        return None
    if due < 0 or due > MAX_DUE_TIMESTAMP:
        raise JsonableError(_("Invalid due date: it must be a time in seconds."))
    return timestamp_to_datetime(due)


# do_update_message_flags runs in a durable transaction of its own, so
# the star is changed before or after the item's own transaction, never
# inside it; the sync it runs is what keeps the two in step meanwhile.


def save_message(user_profile: UserProfile, message_id: int, due: int | None = None) -> SavedItem:
    """Saves the message for later (an item in progress), which stars
    it; saving a message already saved keeps its item and, when a due
    date is given, sets it."""
    due_date = check_due(due)
    access_message(user_profile, message_id, is_modifying_message=False)
    set_star(user_profile, message_id, True)
    with transaction.atomic(durable=True):
        # A message starred before the fork's table existed has no item
        # yet, and starring it again changed nothing.
        item, created = SavedItem.objects.select_for_update(no_key=True).get_or_create(
            user=user_profile, message_id=message_id
        )
        if created:
            send_saved_event(user_profile, "add", item)
        if due_date is not None and item.due != due_date:
            item.due = due_date
            item.save(update_fields=["due"])
            send_saved_event(user_profile, "update", item)
        return item


def update_saved_item(
    user_profile: UserProfile,
    message_id: int,
    *,
    state: str | None,
    due: int | None,
    clear_due: bool,
) -> SavedItem:
    if due is not None and clear_due:
        raise JsonableError(_("Set a due date or clear it, not both."))
    new_state = None if state is None else check_state(state)
    due_date = check_due(due)
    access_message(user_profile, message_id, is_modifying_message=False)
    with transaction.atomic(durable=True):
        old_state = get_saved_item(user_profile, message_id).state
    if old_state == SavedItem.ARCHIVED and new_state not in (None, SavedItem.ARCHIVED):
        # Out of the archive: starred again (the sync puts the item back
        # in progress; the requested state is saved below).
        set_star(user_profile, message_id, True)
    with transaction.atomic(durable=True):
        item = get_saved_item(user_profile, message_id)
        if new_state is not None:
            item.state = new_state
        if due_date is not None:
            item.due = due_date
        if clear_due:
            item.due = None
        item.save(update_fields=["state", "due"])
        send_saved_event(user_profile, "update", item)
    if new_state == SavedItem.ARCHIVED and old_state != SavedItem.ARCHIVED:
        # Into the archive: unstarred; the sync leaves an archived item.
        set_star(user_profile, message_id, False)
    return item


def remove_saved_item(user_profile: UserProfile, message_id: int) -> None:
    """Takes the message off the Later list in any state, and unstars
    it. An item is the user's own, so it can be removed even when its
    message can no longer be read; without an item, the message must be
    readable (so the answer says nothing about other people's
    messages). Removing a message that is not saved is not an error."""
    if not SavedItem.objects.filter(user=user_profile, message_id=message_id).exists():
        access_message(user_profile, message_id, is_modifying_message=False)
        # Unstarred in case the star predates the fork's table.
        set_star(user_profile, message_id, False)
        return
    # Unstarring removes an item that is not archived through the sync;
    # an archived one (never starred) is removed here. Zulip unstars
    # without an access check (the user's own flag).
    set_star(user_profile, message_id, False)
    with transaction.atomic(durable=True):
        SavedItem.objects.filter(user=user_profile, message_id=message_id).delete()
        send_event_on_commit(
            user_profile.realm,
            {"type": "ykphone_saved", "op": "remove", "message_id": message_id},
            [user_profile.id],
        )
