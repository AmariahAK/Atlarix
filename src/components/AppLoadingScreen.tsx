/**
 * Full-screen loading UI shown until the main process has initialized the database.
 * Matches the style used in atlarix-home (logo + rotating ring + copy).
 */
export function AppLoadingScreen() {
  return (
    <div className="fixed inset-0 flex flex-col items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-8">
        <div className="relative">
          <div className="w-24 h-24 rounded-full border-4 border-border flex items-center justify-center bg-background/50 backdrop-blur">
            <img
              src="/logo/Atlarix.png"
              alt="Atlarix"
              className="w-16 h-16 object-contain"
            />
          </div>
          <div className="absolute inset-0 border-4 border-transparent border-t-primary rounded-full animate-spin" />
        </div>
        <div className="text-center space-y-2">
          <h2 className="text-2xl font-semibold">Initializing...</h2>
          <p className="text-muted-foreground max-w-md">
            Starting Atlarix.
            <br />
            This might take a moment...
          </p>
        </div>
        <div className="axis-line-horizontal w-64 h-px" />
      </div>
    </div>
  );
}
