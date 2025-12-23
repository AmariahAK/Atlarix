/**
 * File Selector Component
 * =======================
 * Dialog for selecting up to 5 files from the user's laptop
 * Requires provider selection first
 */

import { useState } from "react";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { X, File, Image as ImageIcon, FileText, Code } from "lucide-react";

interface SelectedFile {
    path: string;
    name: string;
    size: number;
    type: string;
}

interface FileSelectorProps {
    isOpen: boolean;
    onClose: () => void;
    provider: string; // Provider must be selected first
    onFilesSelected: (files: SelectedFile[]) => void;
    maxFiles?: number;
}

export function FileSelector({
    isOpen,
    onClose,
    provider,
    onFilesSelected,
    maxFiles = 5,
}: FileSelectorProps) {
    const [selectedFiles, setSelectedFiles] = useState<SelectedFile[]>([]);

    const handleBrowseFiles = async () => {
        try {
            // Use Electron's dialog API to show file picker
            const result = await window.electron?.ipcRenderer.invoke(
                "dialog:openFiles",
                {
                    properties: ["openFile", "multiSelections"],
                    filters: [
                        { name: "All Files", extensions: ["*"] },
                        { name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg"] },
                        { name: "Documents", extensions: ["pdf", "txt", "md", "doc", "docx"] },
                        { name: "Code", extensions: ["js", "ts", "tsx", "jsx", "py", "java", "cpp", "go", "rs"] },
                    ],
                }
            );

            if (result && !result.canceled && result.filePaths.length > 0) {
                // Get file info for each selected file
                const filePromises = result.filePaths.slice(0, maxFiles).map(async (path: string) => {
                    const stats = await window.electron?.ipcRenderer.invoke("fs:getFileStats", path);
                    return {
                        path,
                        name: path.split("/").pop() || path.split("\\").pop() || "Unknown",
                        size: stats?.size || 0,
                        type: getFileType(path),
                    };
                });

                const files = await Promise.all(filePromises);
                setSelectedFiles(files);
            }
        } catch (error) {
            console.error("Failed to open file picker:", error);
        }
    };

    const removeFile = (index: number) => {
        setSelectedFiles(prev => prev.filter((_, i) => i !== index));
    };

    const handleConfirm = () => {
        onFilesSelected(selectedFiles);
        setSelectedFiles([]);
        onClose();
    };

    const getFileIcon = (type: string) => {
        switch (type) {
            case "image":
                return <ImageIcon className="h-4 w-4" />;
            case "code":
                return <Code className="h-4 w-4" />;
            case "document":
                return <FileText className="h-4 w-4" />;
            default:
                return <File className="h-4 w-4" />;
        }
    };

    const formatFileSize = (bytes: number) => {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    };

    return (
        <Dialog open={isOpen} onOpenChange={onClose}>
            <DialogContent className="sm:max-w-[500px]">
                <DialogHeader>
                    <DialogTitle>Attach Files</DialogTitle>
                    <DialogDescription>
                        Select up to {maxFiles} files to attach to your message.
                        <br />
                        <span className="text-primary">Provider: {provider}</span>
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-4">
                    {/* Browse Button */}
                    <Button
                        onClick={handleBrowseFiles}
                        className="w-full"
                        variant="default"
                        disabled={selectedFiles.length >= maxFiles}
                    >
                        📎 Browse Files...
                    </Button>

                    {/* Selected Files List */}
                    {selectedFiles.length > 0 && (
                        <div className="space-y-2">
                            <div className="text-sm font-medium">
                                Selected Files ({selectedFiles.length}/{maxFiles})
                            </div>
                            <div className="space-y-2 max-h-60 overflow-y-auto">
                                {selectedFiles.map((file, index) => (
                                    <div
                                        key={index}
                                        className="flex items-center justify-between p-3 border border-border rounded-lg bg-card"
                                    >
                                        <div className="flex items-center gap-3 flex-1 min-w-0">
                                            {getFileIcon(file.type)}
                                            <div className="flex-1 min-w-0">
                                                <p className="text-sm font-medium truncate">{file.name}</p>
                                                <p className="text-xs text-muted-foreground">
                                                    {formatFileSize(file.size)}
                                                </p>
                                            </div>
                                        </div>
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            onClick={() => removeFile(index)}
                                            className="h-8 w-8 p-0"
                                        >
                                            <X className="h-4 w-4" />
                                        </Button>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Action Buttons */}
                    <div className="flex gap-2 justify-end">
                        <Button variant="outline" onClick={onClose}>
                            Cancel
                        </Button>
                        <Button
                            onClick={handleConfirm}
                            disabled={selectedFiles.length === 0}
                        >
                            Attach {selectedFiles.length > 0 && `(${selectedFiles.length})`}
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}

function getFileType(path: string): string {
    const ext = path.split(".").pop()?.toLowerCase() || "";

    const imageExts = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"];
    const codeExts = ["js", "ts", "tsx", "jsx", "py", "java", "cpp", "go", "rs", "php", "rb", "swift"];
    const docExts = ["pdf", "txt", "md", "doc", "docx", "rtf"];

    if (imageExts.includes(ext)) return "image";
    if (codeExts.includes(ext)) return "code";
    if (docExts.includes(ext)) return "document";
    return "file";
}
