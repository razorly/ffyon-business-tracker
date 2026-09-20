import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { toast } from "sonner";
import { isTauri } from "./db";

/**
 * Looks for a newer version on the GitHub releases page and offers to install it.
 * Quiet by default, so the check on start-up says nothing unless there's news.
 */
export async function checkForUpdate(quiet = true) {
  if (!isTauri()) {
    if (!quiet) toast.info("Updates are only available in the desktop app.");
    return;
  }

  const update = await check();
  if (!update) {
    if (!quiet) toast.success("You're on the latest version");
    return;
  }

  toast(`Version ${update.version} is ready`, {
    description: "It downloads in the background, then the app restarts.",
    duration: Infinity,
    action: {
      label: "Install",
      onClick: async () => {
        const id = toast.loading("Downloading the update…");
        try {
          await update.downloadAndInstall();
          toast.dismiss(id);
          await relaunch();
        } catch (e) {
          console.error(e);
          toast.error("The update didn't install — you can download it from GitHub instead", { id });
        }
      },
    },
  });
}
