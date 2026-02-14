import {
  Home,
  Inbox,
  Settings,
  HelpCircle,
  Store,
  BookOpen,
  GitBranch,
  Wrench,
  LogIn,
  LogOut,
  User,
  Github,
  Chrome,
} from "lucide-react";
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
import { SettingsList } from "./SettingsList";

// Menu items.
const items = [
  {
    title: "Apps",
    to: "/",
    icon: Home,
  },
  // Chat removed - everything is in the home page now
  {
    title: "Diagram",
    to: "/diagram",
    icon: GitBranch,
  },
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
  {
    title: "Library",
    to: "/library",
    icon: BookOpen,
  },
];

// Hover state types
type HoverState =
  | "start-hover:app"
  | "start-hover:chat"
  | "start-hover:diagram"
  | "start-hover:tools"
  | "start-hover:settings"
  | "start-hover:library"
  | "clear-hover"
  | "no-hover";

export function AppSidebar() {
  const { state, toggleSidebar } = useSidebar(); // retrieve current sidebar state
  const [hoverState, setHoverState] = useState<HoverState>("no-hover");
  const expandedByHover = useRef(false);
  const [isHelpDialogOpen, setIsHelpDialogOpen] = useState(false); // State for dialog
  const [isDropdownOpen] = useAtom(dropdownOpenAtom);
  const [showAuthMenu, setShowAuthMenu] = useState(false);

  // Auth hook for OAuth login
  const { user, isAuthenticated, signInWithGoogle, signInWithGitHub, signOut, status } = useAuth();

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
  const isAppRoute =
    routerState.location.pathname === "/" ||
    routerState.location.pathname.startsWith("/app-details");
  const isChatRoute = routerState.location.pathname === "/chat";
  const isSettingsRoute = routerState.location.pathname.startsWith("/settings");

  let selectedItem: string | null = null;
  if (hoverState === "start-hover:app") {
    selectedItem = "Apps";
  } else if (hoverState === "start-hover:chat") {
    selectedItem = "Chat";
  } else if (hoverState === "start-hover:diagram") {
    selectedItem = "Diagram";
  } else if (hoverState === "start-hover:tools") {
    selectedItem = "Tools";
  } else if (hoverState === "start-hover:settings") {
    selectedItem = "Settings";
  } else if (hoverState === "start-hover:library") {
    selectedItem = "Library";
  } else if (state === "expanded") {
    if (isAppRoute) {
      selectedItem = "Apps";
    } else if (isChatRoute) {
      selectedItem = "Chat";
    } else if (isSettingsRoute) {
      selectedItem = "Settings";
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
            <SettingsList show={selectedItem === "Settings"} />
          </div>
        </div>
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          {/* OAuth Login/Account Button - Above Help */}
          <SidebarMenuItem>
            {isAuthenticated && user ? (
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

                    {/* Plan badge with upgrade/manage button */}
                    <div className="flex items-center justify-between px-2 py-1.5 mb-2">
                      <span className={`text-xs px-2 py-0.5 rounded-full ${status?.plan === 'pro'
                        ? 'bg-primary/20 text-primary'
                        : 'bg-muted text-muted-foreground'
                        }`}>
                        {status?.plan === 'pro' ? '✨ Pro' : 'Free Plan'}
                      </span>
                      {/* Free tier: show Upgrade button */}
                      {status?.plan === 'free' && (
                        <button
                          onClick={() => {
                            import("@/hooks/useUpgrade").then(({ triggerUpgrade }) => {
                              triggerUpgrade();
                            });
                            setShowAuthMenu(false);
                          }}
                          className="text-xs px-2 py-0.5 bg-primary text-primary-foreground rounded-full hover:bg-primary/90 transition-colors"
                        >
                          Upgrade
                        </button>
                      )}
                      {/* Pro tier (active): show Unsubscribe button */}
                      {status?.plan === 'pro' && status?.subscriptionStatus !== 'cancelled' && (
                        <button
                          onClick={async () => {
                            const confirmed = window.confirm(
                              'Are you sure you want to cancel your Atlarix Pro subscription?\n\nYou will retain access until the end of your billing period.'
                            );
                            if (!confirmed) return;

                            setShowAuthMenu(false);

                            const result = await window.electron?.ipcRenderer?.invoke('auth:cancel-subscription') as { success?: boolean; message?: string; error?: string } | undefined;
                            if (result?.success) {
                              alert(result.message || 'Subscription cancelled. You will retain Pro access until the end of your billing period.');
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

                    {/* Subscription date info for Pro users */}
                    {status?.plan === 'pro' && status?.subscriptionEndsAt && (
                      <div className="px-2 pb-2 mb-2 border-b border-border text-xs text-muted-foreground">
                        {status.subscriptionStatus === 'cancelled' ? (
                          <span>Pro ends: {new Date(status.subscriptionEndsAt).toLocaleDateString('en-GB')}</span>
                        ) : (
                          <span>Next payment: {new Date(status.subscriptionEndsAt).toLocaleDateString('en-GB')}</span>
                        )}
                      </div>
                    )}

                    {/* Pro tier (cancelled): show Subscribe button to re-subscribe */}
                    {status?.plan === 'pro' && status?.subscriptionStatus === 'cancelled' && (
                      <div className="px-2 pb-2 mb-2">
                        <button
                          onClick={() => {
                            import("@/hooks/useUpgrade").then(({ triggerUpgrade }) => {
                              triggerUpgrade();
                            });
                            setShowAuthMenu(false);
                          }}
                          className="w-full text-xs py-1.5 bg-primary text-primary-foreground rounded hover:bg-primary/90 transition-colors"
                        >
                          Subscribe Again
                        </button>
                      </div>
                    )}

                    {/* Sign out button */}
                    <button
                      onClick={() => {
                        signOut();
                        setShowAuthMenu(false);
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
                  <div className="absolute bottom-full left-0 mb-2 w-40 bg-popover border border-border rounded-lg shadow-lg p-2 z-50">
                    <div className="text-xs text-muted-foreground mb-2 px-2">
                      Sign in to sync
                    </div>
                    <button
                      onClick={() => {
                        signInWithGoogle();
                        setShowAuthMenu(false);
                      }}
                      className="w-full flex items-center gap-2 px-2 py-1.5 text-sm hover:bg-accent rounded transition-colors"
                    >
                      <Chrome className="h-4 w-4" />
                      Google
                    </button>
                  </div>
                )}
              </div>
            )}
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
                    className={`flex flex-col items-center gap-1 h-14 mb-2 rounded-2xl ${isActive ? "bg-sidebar-accent" : ""
                      }`}
                    onMouseEnter={() => {
                      if (item.title === "Apps") {
                        onHoverChange("start-hover:app");
                      } else if (item.title === "Chat") {
                        onHoverChange("start-hover:chat");
                      } else if (item.title === "Diagram") {
                        onHoverChange("start-hover:diagram");
                      } else if (item.title === "Tools") {
                        onHoverChange("start-hover:tools");
                      } else if (item.title === "Settings") {
                        onHoverChange("start-hover:settings");
                      } else if (item.title === "Library") {
                        onHoverChange("start-hover:library");
                      }
                    }}
                  >
                    <div className="flex flex-col items-center gap-1">
                      <item.icon className="h-5 w-5" />
                      <span className={"text-xs"}>{item.title}</span>
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
