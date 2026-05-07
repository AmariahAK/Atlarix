import { Paperclip } from "lucide-react";
import { useRef } from "react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";

interface FileAttachmentDropdownProps {
  onFileSelect: (files: FileList) => void;
  disabled?: boolean;
  className?: string;
}

export function FileAttachmentDropdown({
  onFileSelect,
  disabled,
  className,
}: FileAttachmentDropdownProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      onFileSelect(e.target.files);
      e.target.value = "";
    }
  };

  return (
    <>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              disabled={disabled}
              title="Attach files"
              className={className}
              onClick={() => fileInputRef.current?.click()}
            >
              <Paperclip size={20} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Attach files</TooltipContent>
        </Tooltip>
      </TooltipProvider>

      <input
        type="file"
        data-testid="chat-context-file-input"
        ref={fileInputRef}
        onChange={handleFileChange}
        className="hidden"
        multiple
      />
    </>
  );
}
