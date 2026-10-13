import {
  Home,
  Settings,
  HelpCircle,
  Wrench,
  Plug,
  AppWindow,
  LogIn,
  LogOut,
  MoreHorizontal,
  User,
} from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { SHORTCUTS, formatCombo, isMacPlatform } from "@/lib/shortcuts";
import { OAuthSignInButtons } from "@/components/auth/OAuthSignInButtons";
import { Link, useRouterState } from "@tanstack/react-router";
import { useSidebar } from "@/components/ui/sidebar"; // import useSidebar hook
import { useEffect, useState, useRef } from "react";
import { useAuth } from "@/lib/auth/useAuth";

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarTrigger,
} from "@/components/ui/sidebar";
// ChatList removed - unified into home page
import { AppList } from "./AppList";
import { HelpDialog } from "./HelpDialog"; // Import the new dialog
import { triggerUpgrade } from "@/hooks/useUpgrade";
import { useCreditBalance } from "@/hooks/useCreditBalance";
import { SignOutDialog } from "@/components/auth/SignOutDialog";
import { LocalDateTimeClock } from "./LocalDateTimeClock";
import { IpcClient } from "@/ipc/ipc_client";

// Menu items.
const items = [
  {
    title: "Apps",
    to: "/",
    icon: Home,
  },
  // Chat removed - everything is in the home page now
  {
    title: "Tools",
    to: "/tools",
    icon: Wrench,
  },
  {
    title: "Settings",
    to: "/settings",
    icon: Settings,
  },
  // Split from Settings by KIND: everything Atlarix connects TO (model
  // providers, MCP servers, Skills) plus the per-project policy
  // governing what it may do there. Settings is preferences; this is
  // connections. See pages/integrations.tsx.
  {
    title: "Integrations",
    to: "/integrations",
    icon: Plug,
  },
];

// Hover state types
type HoverState =
  | "start-hover:app"
  | "start-hover:chat"
  | "start-hover:tools"
  | "clear-hover"
  | "no-hover";

export function AppSidebar() {
  const { state, toggleSidebar } = useSidebar(); // retrieve current sidebar state
  const [hoverState, setHoverState] = useState<HoverState>("no-hover");
  const expandedByHover = useRef(false);
  const [isHelpDialogOpen, setIsHelpDialogOpen] = useState(false); // State for dialog
  const [moreOpen, setMoreOpen] = useState(false);
  // From the table the accelerator is registered against, never a literal.
  const newWindowChord = (() => {
    const row = SHORTCUTS.find((s) => s.id === "new-window");
    return row ? formatCombo(row.combo, isMacPlatform()) : undefined;
  })();
  const [showAuthMenu, setShowAuthMenu] = useState(false);
  const { balanceCents } = useCreditBalance();

  // Auth hook for OAuth login
  const { user, isAuthenticated, authResolved, status, refreshStatus } =
    useAuth();
  const [signOutOpen, setSignOutOpen] = useState(false);

  useEffect(() => {
    if (showAuthMenu && isAuthenticated) {
      void refreshStatus?.();
    }
  }, [showAuthMenu, isAuthenticated, refreshStatus]);

  useEffect(() => {
    if (hoverState.startsWith("start-hover") && state === "collapsed") {
      expandedByHover.current = true;
      toggleSidebar();
    }
    if (
      hoverState === "clear-hover" &&
      state === "expanded" &&
      expandedByHover.current
    ) {
      toggleSidebar();
      expandedByHover.current = false;
      setHoverState("no-hover");
    }
  }, [hoverState, toggleSidebar, state, setHoverState]);

  const routerState = useRouterState();
  const isAppRoute = routerState.location.pathname === "/";

  let selectedItem: string | null = null;
  if (hoverState === "start-hover:app") {
    selectedItem = "Apps";
  } else if (hoverState === "start-hover:chat") {
    selectedItem = "Chat";
  } else if (hoverState === "start-hover:tools") {
    selectedItem = "Tools";
  } else if (state === "expanded") {
    if (isAppRoute) {
      selectedItem = "Apps";
    }
  }

  return (
    <Sidebar
      collapsible="icon"
      /*
       * `dropdownOpenAtom` used to guard this and the collapse effect above.
       * Nothing ever WROTE it — it was declared in `atoms/uiAtoms.ts`, read
       * only here, and permanently `false`, so both guards were no-ops
       * pretending to hold the sidebar open under a menu. Deleted with the
       * atom rather than wired up: every menu in the rail is a Radix popover
       * now, and those portal outside the sidebar, so a collapse behind one
       * does not take the menu with it.
       */
      onMouseLeave={() => setHoverState("clear-hover")}
    >
      <SidebarContent className="overflow-hidden">
        <div className="flex mt-8">
          {/* Left Column: Menu items */}
          <div className="">
            <SidebarTrigger
              onMouseEnter={() => {
                setHoverState("clear-hover");
              }}
            />
            <AppIcons onHoverChange={setHoverState} />
          </div>
          {/* Sidebar Content - Chat removed, unified into home page */}
          <div className="w-[240px]">
            <AppList show={selectedItem === "Apps"} />
          </div>
        </div>
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          {/* OAuth Login/Account Button - Above Help */}
          <SidebarMenuItem>
            {!authResolved && !isAuthenticated ? (
              // Auth not known yet. The window no longer waits for the session
              // restore (that fixed multi-minute launches on captive-portal
              // networks), so on a signed-in machine this slot briefly has no
              // answer. Showing "Login" here is what made the app look like it
              // logged you out and then logged you back in a few seconds later.
              // Hold the space instead, and commit to signed-out only once main
              // says the restore actually settled.
              <SidebarMenuButton
                size="sm"
                disabled
                aria-label="Checking sign-in status"
                className="font-medium w-14 flex flex-col items-center gap-1 h-14 mb-2 rounded-2xl opacity-60"
              >
                <div className="h-5 w-5 rounded-full bg-muted animate-pulse" />
                <span className="text-xs text-muted-foreground">…</span>
              </SidebarMenuButton>
            ) : isAuthenticated && user ? (
              /*
               * RADIX POPOVER, not a hand-rolled panel.
               *
               * This was `{showAuthMenu && <div className="absolute …">}` with
               * the only way to close it being a second click on the avatar —
               * no outside-click, no Escape, no focus handling. Clicking
               * anywhere else on the app left it sitting over the sidebar, so
               * the user had to go back and find the trigger again to dismiss
               * something they had already moved on from.
               *
               * Radix gives dismiss-on-outside-click, Escape, focus return and
               * collision handling for free, and it is what the rest of the app
               * already uses — the rail was the last place still doing this by
               * hand.
               */
              <Popover open={showAuthMenu} onOpenChange={setShowAuthMenu}>
                <PopoverTrigger asChild>
                  <SidebarMenuButton
                    size="sm"
                    className="font-medium w-14 flex flex-col items-center gap-1 h-14 mb-2 rounded-2xl"
                  >
                    {user.avatar ? (
                      <img
                        src={user.avatar}
                        alt={user.name}
                        className="h-5 w-5 rounded-full border border-primary"
                      />
                    ) : (
                      <div className="h-5 w-5 rounded-full bg-gradient-to-br from-primary to-secondary flex items-center justify-center text-[10px] font-bold text-white">
                        {user.name?.charAt(0)?.toUpperCase() || "U"}
                      </div>
                    )}
                    <span className="text-xs truncate max-w-[50px]">
                      {user.name?.split(" ")[0] || "Account"}
                    </span>
                  </SidebarMenuButton>
                </PopoverTrigger>
                <PopoverContent
                  side="right"
                  align="end"
                  sideOffset={8}
                  className="w-60 p-2"
                >
                    {/* User info */}
                    <div className="px-2 pb-2 mb-2 border-b border-border">
                      <div className="text-xs text-muted-foreground">
                        Signed in as
                      </div>
                      <div
                        className="text-sm font-medium truncate"
                        title={user.email}
                      >
                        {user.email}
                      </div>
                    </div>

                    {/* Atlarix Core credit balance (PAYG) — shown above the plan */}
                    <div className="flex items-center justify-between px-2 pb-2 mb-2 border-b border-border">
                      <span className="text-xs text-muted-foreground">
                        Core credit
                      </span>
                      <span className="text-sm font-semibold text-foreground tabular-nums">
                        {typeof balanceCents === "number"
                          ? `$${(balanceCents / 100).toFixed(2)}`
                          : "—"}
                      </span>
                    </div>

                    {/* Plan badge with upgrade/manage button */}
                    <div className="flex items-center justify-between px-2 py-1.5 mb-2">
                      <span
                        className={`text-xs px-2 py-0.5 rounded-full ${
                          status?.plan === "pro"
                            ? "bg-primary/20 text-primary"
                            : "bg-muted text-muted-foreground"
                        }`}
                      >
                        {status?.plan === "pro" ? "Pro" : "Free Plan"}
                      </span>
                      {/* Free tier: upgrade to Pro */}
                      {status?.plan === "free" && (
                        <button
                          type="button"
                          onClick={() => {
                            setShowAuthMenu(false);
                            void triggerUpgrade();
                          }}
                          className="text-xs px-2 py-0.5 bg-primary text-primary-foreground rounded-full hover:bg-primary/90 transition-colors"
                        >
                          Upgrade
                        </button>
                      )}
                      {/* Pro (active): show Unsubscribe button */}
                      {status?.plan === "pro" &&
                        status?.subscriptionStatus !== "cancelled" && (
                          <button
                            onClick={async () => {
                              const confirmed = window.confirm(
                                "Are you sure you want to cancel your subscription?\n\nYou will retain access until the end of your billing period.",
                              );
                              if (!confirmed) return;

                              setShowAuthMenu(false);

                              const result =
                                (await window.electron?.ipcRenderer?.invoke(
                                  "auth:cancel-subscription",
                                )) as
                                  | {
                                      success?: boolean;
                                      message?: string;
                                      error?: string;
                                    }
                                  | undefined;
                              if (result?.success) {
                                alert(
                                  result.message ||
                                    "Subscription cancelled. You will retain access until the end of your billing period.",
                                );
                              } else {
                                alert(
                                  result?.error ||
                                    "Failed to cancel subscription",
                                );
                              }
                            }}
                            className="text-xs px-2 py-0.5 bg-destructive/10 text-destructive rounded-full hover:bg-destructive/20 transition-colors"
                          >
                            Unsubscribe
                          </button>
                        )}
                    </div>

                    {/* Subscription date info for Pro users — next payment / end date */}
                    {status?.plan === "pro" && status?.subscriptionEndsAt && (
                      <div className="px-2 pb-2 mb-2 border-b border-border text-xs text-muted-foreground">
                        {status.subscriptionStatus === "cancelled" ? (
                          <span>
                            Pro ends:{" "}
                            {new Date(
                              status.subscriptionEndsAt,
                            ).toLocaleDateString("en-GB")}
                          </span>
                        ) : (
                          <span>
                            Next payment:{" "}
                            {new Date(
                              status.subscriptionEndsAt,
                            ).toLocaleDateString("en-GB")}
                          </span>
                        )}
                      </div>
                    )}

                    {/* Pro (cancelled): show Subscribe Again */}
                    {status?.plan === "pro" &&
                      status?.subscriptionStatus === "cancelled" && (
                        <div className="px-2 pb-2 mb-2">
                          <button
                            type="button"
                            onClick={() => {
                              void triggerUpgrade();
                              setShowAuthMenu(false);
                            }}
                            className="w-full text-xs py-1.5 bg-primary text-primary-foreground rounded hover:bg-primary/90 transition-colors"
                          >
                            Subscribe Again
                          </button>
                        </div>
                      )}

                    {/* Account (profile, subscription, team) — use Link like settings child routes so navigation always resolves */}
                    <Link
                      to="/account"
                      onClick={() => setShowAuthMenu(false)}
                      className="w-full flex items-center gap-2 px-2 py-1.5 text-sm hover:bg-muted rounded transition-colors"
                    >
                      <User className="h-4 w-4" />
                      Account
                    </Link>

                    {/* Sign out button */}
                    <button
                      onClick={() => {
                        setShowAuthMenu(false);
                        setSignOutOpen(true);
                      }}
                      className="w-full flex items-center gap-2 px-2 py-1.5 text-sm text-destructive hover:bg-destructive/10 rounded transition-colors"
                    >
                      <LogOut className="h-4 w-4" />
                      Sign Out
                    </button>
                </PopoverContent>
              </Popover>
            ) : (
              // Logged out — same treatment as the account menu above.
              <Popover open={showAuthMenu} onOpenChange={setShowAuthMenu}>
                <PopoverTrigger asChild>
                  <SidebarMenuButton
                    size="sm"
                    className="font-medium w-14 flex flex-col items-center gap-1 h-14 mb-2 rounded-2xl"
                  >
                    <LogIn className="h-5 w-5" />
                    <span className="text-xs">Login</span>
                  </SidebarMenuButton>
                </PopoverTrigger>
                <PopoverContent
                  side="right"
                  align="end"
                  sideOffset={8}
                  className="w-60 p-3"
                >
                  <OAuthSignInButtons
                    size="sm"
                    onAfterClick={() => setShowAuthMenu(false)}
                  />
                </PopoverContent>
              </Popover>
            )}
          </SidebarMenuItem>

          {/*
            NEW WINDOW + HELP, behind one "More".

            These were two more 56px stacked buttons. With the account button
            above them the footer ran to ~224px of a rail whose job is four nav
            items — and neither is something you reach for often. Folding them
            into one popover halves the footer and leaves room for the things
            that will want to live here later (check for updates, what's new)
            without the rail growing again.

            The clock did NOT fold in. It was a 56px button whose tooltip held
            the time, so reading it cost a hover; below, it is simply legible.

            Neither action depends on a workspace — `window:open-blank`
            deliberately opens an UNBOUND window that lands on the chooser.
          */}
          <SidebarMenuItem>
            <Popover open={moreOpen} onOpenChange={setMoreOpen}>
              <PopoverTrigger asChild>
                <SidebarMenuButton
                  size="sm"
                  className="font-medium w-14 flex flex-col items-center gap-1 h-14 mb-1 rounded-2xl"
                  aria-label="More"
                >
                  <MoreHorizontal className="h-5 w-5" />
                  <span className="text-xs">More</span>
                </SidebarMenuButton>
              </PopoverTrigger>
              <PopoverContent
                side="right"
                align="end"
                sideOffset={8}
                className="w-60 p-2"
              >
                <div className="border-b border-border px-2 pb-2">
                  <LocalDateTimeClock
                    variant="welcome"
                    className="text-left"
                    tickMs={1000}
                  />
                </div>
                <button
                  type="button"
                  className="mt-1.5 flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-sm transition-colors hover:bg-muted"
                  onClick={() => {
                    setMoreOpen(false);
                    void IpcClient.getInstance().openBlankWindow();
                  }}
                >
                  <AppWindow className="h-4 w-4 shrink-0" aria-hidden />
                  <span className="flex-1 text-left">New window</span>
                  {newWindowChord && (
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {newWindowChord}
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  className="flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-sm transition-colors hover:bg-muted"
                  onClick={() => {
                    setMoreOpen(false);
                    setIsHelpDialogOpen(true);
                  }}
                >
                  <HelpCircle className="h-4 w-4 shrink-0" aria-hidden />
                  <span className="flex-1 text-left">Help &amp; shortcuts</span>
                </button>
              </PopoverContent>
            </Popover>
            <HelpDialog
              isOpen={isHelpDialogOpen}
              onClose={() => setIsHelpDialogOpen(false)}
            />
          </SidebarMenuItem>

          <SidebarMenuItem>
            <div className="w-14 pb-2">
              <LocalDateTimeClock variant="rail" />
            </div>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      <SidebarRail />
      <SignOutDialog open={signOutOpen} onOpenChange={setSignOutOpen} />
    </Sidebar>
  );
}

function AppIcons({
  onHoverChange,
}: {
  onHoverChange: (state: HoverState) => void;
}) {
  const routerState = useRouterState();
  const pathname = routerState.location.pathname;

  return (
    // When collapsed: only show the main menu
    <SidebarGroup className="pr-0">
      {/* <SidebarGroupLabel>Atlarix</SidebarGroupLabel> */}

      <SidebarGroupContent>
        <SidebarMenu>
          {items.map((item) => {
            const isActive =
              (item.to === "/" && pathname === "/") ||
              (item.to !== "/" && pathname.startsWith(item.to));

            return (
              <SidebarMenuItem key={item.title}>
                <SidebarMenuButton
                  asChild
                  size="sm"
                  className="font-medium w-14"
                >
                  <Link
                    to={item.to}
                    data-onboarding={
                      item.title === "Settings" ? "settings-link" : undefined
                    }
                    data-tour={
                      item.title === "Settings" ? "tour-extensions" : undefined
                    }
                    className={`flex flex-col items-center justify-center gap-1 min-h-14 py-1.5 mb-2 rounded-2xl ${
                      isActive ? "bg-sidebar-accent" : ""
                    }`}
                    onMouseEnter={() => {
                      if (item.title === "Apps") {
                        onHoverChange("start-hover:app");
                      } else if (item.title === "Chat") {
                        onHoverChange("start-hover:chat");
                      } else if (item.title === "Tools") {
                        onHoverChange("start-hover:tools");
                      } else {
                        // Settings and Integrations navigate straight to their
                        // page — their nav is the top tab row there, so hovering
                        // must not expand a 240px column with nothing in it.
                        onHoverChange("clear-hover");
                      }
                    }}
                  >
                    <div className="flex flex-col items-center gap-0.5 w-full min-w-0">
                      <item.icon className="h-5 w-5 shrink-0" />
                      {/* The rail is 56px wide. "Integrations" overflowed it at
                          text-xs and was clipped to "ntegration", so long labels
                          step down a size and wrap instead — renaming the page to
                          fit the sidebar would be the tail wagging the dog. */}
                      <span
                        className={
                          item.title.length > 8
                            ? // One line at 9px: break-words cut "Integra/tions"
                              // (QA #11), and hyphens-auto never hyphenated it, so
                              // it clipped to "Integratio" (QA #45).
                              "text-[9px] leading-tight text-center w-full whitespace-nowrap tracking-tight"
                            : "text-xs"
                        }
                      >
                        {item.title}
                      </span>
                    </div>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
