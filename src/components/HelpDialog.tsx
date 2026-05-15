import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  BookOpenIcon,
  BugIcon,
  SendIcon,
  ImagePlusIcon,
  XIcon,
  SparklesIcon,
  MessageSquare,
} from "lucide-react";
import { IpcClient } from "@/ipc/ipc_client";
import { useState, useEffect, useRef } from "react";
import { HelpBotDialog } from "./HelpBotDialog";
import { useSettings } from "@/hooks/useSettings";
import { useAuth } from "@/lib/auth/useAuth";
import { DISCORD_INVITE_URL } from "@/lib/community/discord";

interface HelpDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

export function HelpDialog({ isOpen, onClose }: HelpDialogProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [showBugForm, setShowBugForm] = useState(false);
  const [isHelpBotOpen, setIsHelpBotOpen] = useState(false);
  const [bugFormData, setBugFormData] = useState({
    email: "",
    subject: "",
    message: "",
  });
  const [attachments, setAttachments] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { settings } = useSettings();
  const { user } = useAuth();
  const isAtlarixProUser = settings?.providerSettings?.["auto"]?.apiKey?.value;

  // Auto-fill email if user is logged in
  useEffect(() => {
    if (user?.email && !bugFormData.email) {
      setBugFormData((prev) => ({ ...prev, email: user.email }));
    }
  }, [user?.email, bugFormData.email]);

  // Reset state when dialog closes
  useEffect(() => {
    if (!isOpen) {
      setShowBugForm(false);
      setBugFormData({ email: "", subject: "", message: "" });
      setAttachments([]);
      setIsLoading(false);
    }
  }, [isOpen]);

  const handleClose = () => {
    onClose();
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files) {
      const imageFiles = Array.from(files).filter((f) =>
        f.type.startsWith("image/")
      );
      setAttachments((prev) => [...prev, ...imageFiles].slice(0, 5)); // Max 5 images
    }
  };

  const removeAttachment = (index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSubmitBugReport = async () => {
    if (!bugFormData.email || !bugFormData.subject || !bugFormData.message) {
      alert("Please fill in all required fields");
      return;
    }

    setIsLoading(true);
    try {
      // Get system debug info for additional context
      let debugInfo = "";
      try {
        const info = await IpcClient.getInstance().getSystemDebugInfo();
        debugInfo = `
---
System Info:
- Version: ${info.atlarixVersion}
- Platform: ${info.platform} ${info.architecture}
- Node: ${info.nodeVersion || "N/A"}
`;
      } catch {
        debugInfo = "";
      }

      // Compose email body
      const emailBody = `${bugFormData.message}${debugInfo}`;

      // Create mailto URL with attachments note
      const attachmentNote =
        attachments.length > 0
          ? `\n\n[Note: ${attachments.length} image(s) attached - please attach them manually in your email client]`
          : "";

      const mailto = `mailto:support@atlarix.dev?subject=${encodeURIComponent(
        bugFormData.subject
      )}&body=${encodeURIComponent(emailBody + attachmentNote)}`;

      // Open default email client
      IpcClient.getInstance().openExternalUrl(mailto);

      // Reset form
      setShowBugForm(false);
      setBugFormData({ email: user?.email || "", subject: "", message: "" });
      setAttachments([]);
      handleClose();
    } catch (error) {
      console.error("Failed to prepare bug report:", error);
      alert("Failed to open email client. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  // Bug report form view
  if (showBugForm) {
    return (
      <Dialog open={isOpen} onOpenChange={handleClose}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center">
              <Button
                variant="ghost"
                className="mr-2 p-0 h-8 w-8"
                onClick={() => setShowBugForm(false)}
              >
                <XIcon className="h-4 w-4" />
              </Button>
              Report a Bug
            </DialogTitle>
          </DialogHeader>
          <DialogDescription>
            Describe your issue and we'll get back to you as soon as possible.
          </DialogDescription>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="email">Your Email *</Label>
              <Input
                id="email"
                type="email"
                placeholder="your@email.com"
                value={bugFormData.email}
                onChange={(e) =>
                  setBugFormData((prev) => ({ ...prev, email: e.target.value }))
                }
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="subject">Subject *</Label>
              <Input
                id="subject"
                placeholder="Brief description of the issue"
                value={bugFormData.subject}
                onChange={(e) =>
                  setBugFormData((prev) => ({
                    ...prev,
                    subject: e.target.value,
                  }))
                }
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="message">Message *</Label>
              <Textarea
                id="message"
                placeholder="Please describe what happened, steps to reproduce, and what you expected..."
                rows={5}
                value={bugFormData.message}
                onChange={(e) =>
                  setBugFormData((prev) => ({
                    ...prev,
                    message: e.target.value,
                  }))
                }
              />
            </div>

            <div className="space-y-2">
              <Label>Attachments (optional)</Label>
              <div className="flex flex-wrap gap-2">
                {attachments.map((file, index) => (
                  <div
                    key={index}
                    className="flex items-center gap-1 bg-muted px-2 py-1 rounded text-sm"
                  >
                    <span className="truncate max-w-[100px]">{file.name}</span>
                    <button
                      onClick={() => removeAttachment(index)}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <XIcon className="h-3 w-3" />
                    </button>
                  </div>
                ))}
                {attachments.length < 5 && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <ImagePlusIcon className="h-4 w-4 mr-1" />
                    Add Image
                  </Button>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  className="hidden"
                  onChange={handleFileSelect}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Max 5 images. They'll be noted in the email for you to attach.
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowBugForm(false)}>
              Cancel
            </Button>
            <Button onClick={handleSubmitBugReport} disabled={isLoading}>
              <SendIcon className="h-4 w-4 mr-2" />
              {isLoading ? "Sending..." : "Send Report"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  // Main help dialog
  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Need help with Atlarix?</DialogTitle>
        </DialogHeader>
        <DialogDescription>
          If you need help or want to report an issue, here are some options:
        </DialogDescription>
        <div className="flex flex-col space-y-4 w-full">
          {isAtlarixProUser ? (
            <div className="flex flex-col space-y-2">
              <Button
                variant="default"
                onClick={() => {
                  setIsHelpBotOpen(true);
                }}
                className="w-full py-6 border-primary/50 shadow-sm shadow-primary/10 transition-all hover:shadow-md hover:shadow-primary/15"
              >
                <SparklesIcon className="mr-2 h-5 w-5" /> Chat with Atlarix help
                bot (Pro)
              </Button>
              <p className="text-sm text-muted-foreground px-2">
                Opens an in-app help chat assistant that searches through
                Atlarix's docs.
              </p>
            </div>
          ) : (
            <div className="flex flex-col space-y-2">
              <Button
                variant="outline"
                onClick={() => {
                  IpcClient.getInstance().openExternalUrl(
                    "https://www.atlarix.dev/docs"
                  );
                }}
                className="w-full py-6 bg-(--background-lightest)"
              >
                <BookOpenIcon className="mr-2 h-5 w-5" /> Open Docs
              </Button>
              <p className="text-sm text-muted-foreground px-2">
                Get help with common questions and issues.
              </p>
            </div>
          )}

          <div className="flex flex-col space-y-2">
            <Button
              variant="outline"
              onClick={() => IpcClient.getInstance().openExternalUrl(DISCORD_INVITE_URL)}
              className="w-full py-6 bg-(--background-lightest)"
            >
              <MessageSquare className="mr-2 h-5 w-5" /> Community (Discord)
            </Button>
            <p className="text-sm text-muted-foreground px-2">
              Chat with other builders, get updates, and ask questions in our Discord server.
            </p>
          </div>

          <div className="flex flex-col space-y-2">
            <Button
              variant="outline"
              onClick={() => setShowBugForm(true)}
              className="w-full py-6 bg-(--background-lightest)"
            >
              <BugIcon className="mr-2 h-5 w-5" /> Report a Bug
            </Button>
            <p className="text-sm text-muted-foreground px-2">
              Send us an email with details about your issue. We'll get back to
              you promptly.
            </p>
          </div>
        </div>
      </DialogContent>
      <HelpBotDialog
        isOpen={isHelpBotOpen}
        onClose={() => setIsHelpBotOpen(false)}
      />
    </Dialog>
  );
}
