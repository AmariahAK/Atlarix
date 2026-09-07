import {
  Home,
  Settings,
  HelpCircle,
  Wrench,
  Plug,
  AppWindow,
  LogIn,
  LogOut,
  User,
} from "lucide-react";
import { OAuthSignInButtons } from "@/components/auth/OAuthSignInButtons";
import { Link, useRouterState } from "@tanstack/react-router";
import { useSidebar } from "@/components/ui/sidebar"; // import useSidebar hook
import { useEffect, useState, useRef } from "react";
import { useAtom } from "jotai";
import { dropdownOpenAtom } from "@/atoms/uiAtoms";
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
  const [isDropdownOpen] = useAtom(dropdownOpenAtom);
  const [showAuthMenu, setShowAuthMenu] = useState(false);
  const { balanceCents } = useCreditBalance();

  // Auth hook for OAuth login
  const {
    user,
    isAuthenticated,
    authResolved,
    status,
    refreshStatus,
  } = useAuth();
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
      expandedByHover.current &&
      !isDropdownOpen
    ) {
      toggleSidebar();
      expandedByHover.current = false;
      setHoverState("no-hover");
    }
  }, [hoverState, toggleSidebar, state, setHoverState, isDropdownOpen]);

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
      onMouseLeave={() => {
        if (!isDropdownOpen) {
          setHoverState("clear-hover");
        }
      }}
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
              // Logged in - show user avatar/name
              <div className="relative">
                <SidebarMenuButton
                  size="sm"
                  className="font-medium w-14 flex flex-col items-center gap-1 h-14 mb-2 rounded-2xl"
                  onClick={() => setShowAuthMenu(!showAuthMenu)}
                >
                  {user.avatar ? (
                    <img
                      src={user.avatar}
                      alt={user.name}
                      className="h-5 w-5 rounded-full border border-primary"
                    />
                  ) : (
                    <div className="h-5 w-5 rounded-full bg-gradient-to-br from-primary to-secondary flex items-center justify-center text-[10px] font-bold text-white">
                      {user.name?.charAt(0)?.toUpperCase() || 'U'}
                    </div>
                  )}
                  <span className="text-xs truncate max-w-[50px]">
                    {user.name?.split(' ')[0] || 'Account'}
                  </span>
                </SidebarMenuButton>

                {/* Dropdown menu for sign out */}
                {showAuthMenu && (
                  <div className="absolute bottom-full left-0 mb-2 w-48 bg-popover border border-border rounded-lg shadow-lg p-2 z-50">
                    {/* User info */}
                    <div className="px-2 pb-2 mb-2 border-b border-border">
                      <div className="text-xs text-muted-foreground">Signed in as</div>
                      <div className="text-sm font-medium truncate" title={user.email}>
                        {user.email}
                      </div>
                    </div>

                    {/* Atlarix Core credit balance (PAYG) — shown above the plan */}
                    <div className="flex items-center justify-between px-2 pb-2 mb-2 border-b border-border">
                      <span className="text-xs text-muted-foreground">Core credit</span>
                      <span className="text-sm font-semibold text-foreground tabular-nums">
                        {typeof balanceCents === "number" ? `$${(balanceCents / 100).toFixed(2)}` : "—"}
                      </span>
                    </div>

                    {/* Plan badge with upgrade/manage button */}
                    <div className="flex items-center justify-between px-2 py-1.5 mb-2">
                      <span className={`text-xs px-2 py-0.5 rounded-full ${status?.plan === 'pro'
                        ? 'bg-primary/20 text-primary'
                        : 'bg-muted text-muted-foreground'
                        }`}>
                        {status?.plan === 'pro' ? 'Pro' : 'Free Plan'}
                      </span>
                      {/* Free tier: upgrade to Pro */}
                      {status?.plan === 'free' && (
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
                      {status?.plan === 'pro' && status?.subscriptionStatus !== 'cancelled' && (
                        <button
                          onClick={async () => {
                            const confirmed = window.confirm(
                              'Are you sure you want to cancel your subscription?\n\nYou will retain access until the end of your billing period.'
                            );
                            if (!confirmed) return;

                            setShowAuthMenu(false);

                            const result = await window.electron?.ipcRenderer?.invoke('auth:cancel-subscription') as { success?: boolean; message?: string; error?: string } | undefined;
                            if (result?.success) {
                              alert(result.message || 'Subscription cancelled. You will retain access until the end of your billing period.');
                            } else {
                              alert(result?.error || 'Failed to cancel subscription');
                            }
                          }}
                          className="text-xs px-2 py-0.5 bg-destructive/10 text-destructive rounded-full hover:bg-destructive/20 transition-colors"
                        >
                          Unsubscribe
                        </button>
                      )}
                    </div>

                    {/* Subscription date info for Pro users — next payment / end date */}
                    {status?.plan === 'pro' && status?.subscriptionEndsAt && (
                      <div className="px-2 pb-2 mb-2 border-b border-border text-xs text-muted-foreground">
                        {status.subscriptionStatus === 'cancelled' ? (
                          <span>Pro ends: {new Date(status.subscriptionEndsAt).toLocaleDateString('en-GB')}</span>
                        ) : (
                          <span>Next payment: {new Date(status.subscriptionEndsAt).toLocaleDateString('en-GB')}</span>
                        )}
                      </div>
                    )}

                    {/* Pro (cancelled): show Subscribe Again */}
                    {status?.plan === 'pro' && status?.subscriptionStatus === 'cancelled' && (
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
                  </div>
                )}
              </div>
            ) : (
              // Logged out - show login button
              <div className="relative">
                <SidebarMenuButton
                  size="sm"
                  className="font-medium w-14 flex flex-col items-center gap-1 h-14 mb-2 rounded-2xl"
                  onClick={() => setShowAuthMenu(!showAuthMenu)}
                >
                  <LogIn className="h-5 w-5" />
                  <span className="text-xs">Login</span>
                </SidebarMenuButton>

                {/* Dropdown menu for login options */}
                {showAuthMenu && (
                  <div className="absolute bottom-full left-0 mb-2 w-60 bg-popover border border-border rounded-lg shadow-lg p-3 z-50">
                    <OAuthSignInButtons
                      size="sm"
                      onAfterClick={() => setShowAuthMenu(false)}
                    />
                  </div>
                )}
              </div>
            )}
          </SidebarMenuItem>

          {/* New window + clock. They lived in the AppList group header, which
              only renders while the Apps rail item is hovered or the route is
              "/", so they were effectively Home-only. Neither depends on a
              workspace — `window:open-blank` deliberately opens an UNBOUND window
              that lands on the chooser — so the rail is where they belong. */}
          <SidebarMenuItem>
            <SidebarMenuButton
              size="sm"
              className="font-medium w-14 flex flex-col items-center gap-1 h-14 mb-2 rounded-2xl"
              title="Open a new window"
              onClick={() => {
                void IpcClient.getInstance().openBlankWindow();
              }}
            >
              <AppWindow className="h-5 w-5" />
              <span className={"text-xs"}>Window</span>
            </SidebarMenuButton>
          </SidebarMenuItem>

          <SidebarMenuItem>
            <div className="w-14 flex items-center justify-center mb-2">
              <LocalDateTimeClock variant="compact" tickMs={1000} />
            </div>
          </SidebarMenuItem>

          {/* Help Button */}
          <SidebarMenuItem>
            {/* Change button to open dialog instead of linking */}
            <SidebarMenuButton
              size="sm"
              className="font-medium w-14 flex flex-col items-center gap-1 h-14 mb-2 rounded-2xl"
              onClick={() => setIsHelpDialogOpen(true)} // Open dialog on click
            >
              <HelpCircle className="h-5 w-5" />
              <span className={"text-xs"}>Help</span>
            </SidebarMenuButton>
            <HelpDialog
              isOpen={isHelpDialogOpen}
              onClose={() => setIsHelpDialogOpen(false)}
            />
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
                    data-onboarding={item.title === "Settings" ? "settings-link" : undefined}
                    data-tour={item.title === "Settings" ? "tour-extensions" : undefined}
                    className={`flex flex-col items-center justify-center gap-1 min-h-14 py-1.5 mb-2 rounded-2xl ${isActive ? "bg-sidebar-accent" : ""
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
                            ? "text-[10px] leading-tight text-center w-full px-0.5 break-words"
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
