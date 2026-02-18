import { IpcClient } from "@/ipc/ipc_client";
import { Play } from "lucide-react";

export const OnboardingBanner = ({
  isVisible,
  setIsVisible,
}: {
  isVisible: boolean;
  setIsVisible: (isVisible: boolean) => void;
}) => {
  if (!isVisible) return null;

  return (
    // <div className="fixed top-0 left-0 right-0 z-50 flex justify-center mt-2">
    <div className="max-w-xl w-full mx-4 relative mb-4">
      <a
        onClick={(e) => {
          e.preventDefault();
          IpcClient.getInstance().openExternalUrl(
            "https://youtu.be/oTlJXBS1azM",
          );
          setIsVisible(false);
        }}
        target="_blank"
        rel="noopener noreferrer"
        className="cursor-pointer block bg-(--background-lightest) border border-border rounded-lg shadow-lg hover:bg-accent transition-colors overflow-hidden group"
      >
        <div className="relative aspect-video w-full">
          <img
            src="/images/setup-thumbnail.jpg"
            alt="Setup Atlarix Guide"
            className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-105"
          />
          <div className="absolute inset-0 flex items-center justify-center bg-black/20 group-hover:bg-black/10 transition-colors">
            <div className="w-16 h-16 bg-white/90 rounded-full flex items-center justify-center shadow-lg backdrop-blur-sm transition-transform duration-300 group-hover:scale-110">
              <Play size={32} className="text-primary ml-1" fill="currentColor" />
            </div>
          </div>
        </div>
      </a>
    </div>
    // </div>
  );
};
