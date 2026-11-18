import { describeAuthError } from "@osn/client";
import { toast } from "@shared/toast";
import { Button } from "@shared/ui/ui/button";
import { createSignal, type JSX } from "solid-js";

import { statusOf } from "../lib/account-deletion";
import { accountClient } from "../lib/authClients";
import { saveFile } from "../lib/save-file";
import { createStepUp } from "../lib/step-up";

/** The file name the download takes when the server's cannot be read. */
export const EXPORT_FILE_NAME = "musubi-account-export.ndjson";

const DOWNLOAD_LIMIT = "You can download your data once a day. Try again tomorrow.";
const LINK_LIMIT = "You can ask for three links a day. Try again tomorrow.";

export interface AccountData {
  /** Steps up for `account_export`, downloads the account's data and saves it. */
  download: () => Promise<void>;
  /** Emails the account's own address a link to the download. */
  sendLink: () => Promise<void>;
  downloading: () => boolean;
  sending: () => boolean;
  /** The step-up sheet the download opens; mount it once in the screen. */
  Sheet: () => JSX.Element;
}

/**
 * The two ways to take a copy of the account's data: download it now, after
 * a step-up, or have a link to the download emailed to the account's own
 * address. The email carries the link, never the data. Each says how it went
 * in a toast; a limit reached says when to try again.
 */
export function createAccountData(): AccountData {
  const stepUp = createStepUp();
  const [downloading, setDownloading] = createSignal(false);
  const [sending, setSending] = createSignal(false);

  async function download() {
    if (downloading() || stepUp.open()) return;
    const token = await stepUp.ask({
      purpose: "account_export",
      reason: "To download your data, confirm it's you.",
    });
    if (token === null) return;
    setDownloading(true);
    try {
      const file = await accountClient.exportAccount({ stepUpToken: token });
      const name = file.fileName ?? EXPORT_FILE_NAME;
      saveFile(file.blob, name);
      toast.success(`Downloaded ${name}`);
    } catch (err) {
      toast.error(
        statusOf(err) === 429
          ? DOWNLOAD_LIMIT
          : `Couldn't download your data. ${describeAuthError(err)}`,
      );
    } finally {
      setDownloading(false);
    }
  }

  async function sendLink() {
    if (sending()) return;
    setSending(true);
    try {
      await accountClient.sendDataLink();
      toast.success("Check your email for a link to download your data.");
    } catch (err) {
      toast.error(
        statusOf(err) === 429 ? LINK_LIMIT : `Couldn't send the link. ${describeAuthError(err)}`,
      );
    } finally {
      setSending(false);
    }
  }

  return { download, sendLink, downloading, sending, Sheet: stepUp.Sheet };
}

/**
 * "Download my data" and "Send me a link", side by side, wrapping on a narrow
 * screen. Each is busy while its own call runs and leaves the other alone.
 */
export function AccountDataActions() {
  const data = createAccountData();
  return (
    <div class="flex flex-wrap gap-2">
      <Button
        variant="secondary"
        size="sm"
        class="max-md:h-10"
        busy={data.downloading()}
        onClick={() => void data.download()}
      >
        {data.downloading() ? "Downloading…" : "Download my data"}
      </Button>
      <Button
        variant="secondary"
        size="sm"
        class="max-md:h-10"
        busy={data.sending()}
        onClick={() => void data.sendLink()}
      >
        {data.sending() ? "Sending…" : "Send me a link"}
      </Button>
      <data.Sheet />
    </div>
  );
}
