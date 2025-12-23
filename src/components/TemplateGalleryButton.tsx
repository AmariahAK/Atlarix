import { useState } from "react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { TemplateBrowser } from "./templates/TemplateBrowser";
import type { Template } from "@/shared/templates";
import { CreateAppDialog } from "./CreateAppDialog";
import { Button } from "./ui/button";
import { LayoutGrid } from "lucide-react";

export function TemplateGalleryButton() {
    const [isGalleryOpen, setIsGalleryOpen] = useState(false);
    const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
    const [selectedTemplate, setSelectedTemplate] = useState<Template | undefined>();

    const handleTemplateSelect = (template: Template) => {
        setSelectedTemplate(template);
        setIsGalleryOpen(false);
        setIsCreateDialogOpen(true);
    };

    return (
        <>
            {/* Browse Templates Button - matches home page style */}
            <button
                type="button"
                onClick={() => setIsGalleryOpen(true)}
                className="flex items-center gap-2 px-4 py-2 rounded-xl border border-gray-200
                   bg-white/50 backdrop-blur-sm
                   transition-all duration-200
                   hover:bg-white hover:shadow-md hover:border-gray-300
                   active:scale-[0.98]
                   dark:bg-gray-800/50 dark:border-gray-700
                   dark:hover:bg-gray-800 dark:hover:border-gray-600"
            >
                <LayoutGrid className="w-5 h-5 text-gray-700 dark:text-gray-300" />
                <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                    Browse Templates
                </span>
            </button>

            {/* Template Browser Modal */}
            <Dialog open={isGalleryOpen} onOpenChange={setIsGalleryOpen}>
                <DialogContent className="max-w-6xl h-[80vh] p-0">
                    <TemplateBrowser
                        onSelect={handleTemplateSelect}
                        onClose={() => setIsGalleryOpen(false)}
                    />
                </DialogContent>
            </Dialog>

            {/* Create App Dialog (after template selection) */}
            <CreateAppDialog
                open={isCreateDialogOpen}
                onOpenChange={setIsCreateDialogOpen}
                template={selectedTemplate}
            />
        </>
    );
}
