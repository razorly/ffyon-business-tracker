import { toast } from "sonner";
import { undoDelete, type DeletedSnapshot } from "./db";

/** How long she gets to change her mind — long enough to read the message and reach for it. */
const UNDO_MS = 12_000;

/**
 * Accounting deletes may be undone; permanent customer/booking deletion cannot.
 * `onUndone` re-reads the data once it is restored.
 */
export function toastDeleted(snap: DeletedSnapshot, onUndone: () => void) {
  if (snap.undoable === false) {
    toast.success(snap.message ?? `${snap.label} updated`);
    return;
  }
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
