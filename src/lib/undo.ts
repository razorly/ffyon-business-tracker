import { toast } from "sonner";
import { undoDelete, type DeletedSnapshot } from "./db";

/** How long she gets to change her mind — long enough to read the message and reach for it. */
const UNDO_MS = 12_000;

/**
 * The message shown after anything is deleted, with a way to take it back.
 * Every delete goes through here, so nothing in the app is ever lost to a
 * mis-click. `onUndone` re-reads the data once it's back.
 */
export function toastDeleted(snap: DeletedSnapshot, onUndone: () => void) {
  toast.success(`${snap.label} deleted`, {
    duration: UNDO_MS,
    action: {
      label: "Undo",
      onClick: async () => {
        try {
          await undoDelete(snap);
          toast.success(`${snap.label} put back`);
          onUndone();
        } catch (e) {
          console.error(e);
          toast.error("Couldn't undo that — please try again.");
        }
      },
    },
  });
}
