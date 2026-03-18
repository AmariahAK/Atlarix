import {
  Home,
  Inbox,
  Settings,
  HelpCircle,
  BookOpen,
  GitBranch,
  Wrench,
  LogIn,
  LogOut,
  User,
  Github,
  Chrome,
  LayoutGrid,
} from "lucide-react";
import { Link, useRouterState, useNavigate } from "@tanstack/react-router";
import { useSidebar } from "@/components/ui/sidebar"; // import useSidebar hook
import { useEffect, useState, useRef } from "react";
import { useAtom, useSetAtom } from "jotai";
import { dropdownOpenAtom } from "@/atoms/uiAtoms";
import { activeExtensionIdsAtom, selectedExtensionIdAtom } from "@/atoms/viewAtoms";
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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
// ChatList removed - unified into home page
import { AppList } from "./AppList";
import { HelpDialog } from "./HelpDialog"; // Import the new dialog
import { SettingsList } from "./SettingsList";
import { ExtensionManagerDialog } from "./extensions/ExtensionManagerDialog";
import { triggerUpgrade } from "@/hooks/useUpgrade";

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
  const [isExtensionManagerOpen, setIsExtensionManagerOpen] = useState(false);
  const [showExtensionsGateDialog, setShowExtensionsGateDialog] = useState(false);
  const [activeExtensionIds, setActiveExtensionIds] = useAtom(activeExtensionIdsAtom);
  const setSelectedExtensionId = useSetAtom(selectedExtensionIdAtom);
  const navigate = useNavigate();

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
                      <span className={`text-xs px-2 py-0.5 rounded-full ${status?.plan === 'pro' || status?.plan === 'workforce'
                        ? 'bg-primary/20 text-primary'
                        : 'bg-muted text-muted-foreground'
                        }`}>
                        {status?.plan === 'workforce' ? '✨ Workforce' : status?.plan === 'pro' ? '✨ Pro' : 'Free Plan'}
                      </span>
                      {/* Free tier: show Upgrade choice (Pro vs Workforce) */}
                      {status?.plan === 'free' && (
                        <div className="flex gap-1">
                          <button
                            onClick={() => {
                              import("@/hooks/useUpgrade").then(({ triggerUpgrade }) => {
                                triggerUpgrade();
                              });
                              setShowAuthMenu(false);
                            }}
                            className="text-xs px-2 py-0.5 bg-primary text-primary-foreground rounded-full hover:bg-primary/90 transition-colors"
                          >
                            Pro
                          </button>
                          <button
                            onClick={() => {
                              import("@/hooks/useUpgrade").then(({ triggerUpgradeWorkforce }) => {
                                triggerUpgradeWorkforce();
                              });
                              setShowAuthMenu(false);
                            }}
                            className="text-xs px-2 py-0.5 bg-primary/80 text-primary-foreground rounded-full hover:bg-primary/90 transition-colors"
                          >
                            Workforce
                          </button>
                        </div>
                      )}
                      {/* Pro or Workforce (active): show Unsubscribe button */}
                      {(status?.plan === 'pro' || status?.plan === 'workforce') && status?.subscriptionStatus !== 'cancelled' && (
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

                    {/* Subscription date info for Pro/Workforce users — same tier date, next payment */}
                    {(status?.plan === 'pro' || status?.plan === 'workforce') && status?.subscriptionEndsAt && (
                      <div className="px-2 pb-2 mb-2 border-b border-border text-xs text-muted-foreground">
                        {status.subscriptionStatus === 'cancelled' ? (
                          <span>{status.plan === 'workforce' ? 'Workforce' : 'Pro'} ends: {new Date(status.subscriptionEndsAt).toLocaleDateString('en-GB')}</span>
                        ) : (
                          <span>Next payment: {new Date(status.subscriptionEndsAt).toLocaleDateString('en-GB')}</span>
                        )}
                      </div>
                    )}

                    {/* Pro or Workforce (cancelled): show Subscribe Again */}
                    {(status?.plan === 'pro' || status?.plan === 'workforce') && status?.subscriptionStatus === 'cancelled' && (
                      <div className="px-2 pb-2 mb-2">
                        <button
                          onClick={() => {
                            const openAgain = status?.plan === 'workforce'
                              ? import("@/hooks/useUpgrade").then(({ triggerUpgradeWorkforce }) => triggerUpgradeWorkforce())
                              : import("@/hooks/useUpgrade").then(({ triggerUpgrade }) => triggerUpgrade());
                            openAgain.then(() => setShowAuthMenu(false));
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
                    <button
                      onClick={() => {
                        signInWithGitHub();
                        setShowAuthMenu(false);
                      }}
                      className="w-full flex items-center gap-2 px-2 py-1.5 text-sm hover:bg-accent rounded transition-colors"
                    >
                      <Github className="h-4 w-4" />
                      GitHub
                    </button>
                  </div>
                )}
              </div>
            )}
          </SidebarMenuItem>

          {/* Extensions - above Help; Pro-gated: show gate dialog when not Pro */}
          <SidebarMenuItem>
            <SidebarMenuButton
              size="sm"
              className="font-medium w-14 flex flex-col items-center gap-1 h-14 mb-2 rounded-2xl relative"
              onClick={() => {
                if (status?.plan === "pro") {
                  setIsExtensionManagerOpen(true);
                } else {
                  setShowExtensionsGateDialog(true);
                }
              }}
            >
              <LayoutGrid className="h-5 w-5" />
              <span className="text-xs">Extensions</span>
              {status?.plan !== "pro" && (
                <span className="absolute -top-0.5 -right-0.5 rounded bg-primary/20 text-primary text-[9px] font-semibold px-1">
                  Pro
                </span>
              )}
            </SidebarMenuButton>
            <Dialog open={showExtensionsGateDialog} onOpenChange={setShowExtensionsGateDialog}>
              <DialogContent className="sm:max-w-md" showCloseButton>
                <DialogHeader>
                  <DialogTitle>
                    {!isAuthenticated ? "Log in to use Extensions" : "Upgrade to use Extensions & DB"}
                  </DialogTitle>
                  <DialogDescription>
                    {!isAuthenticated
                      ? "Extensions and DB Connections require an account. Log in with Google or GitHub, then upgrade to Pro to use them."
                      : "DB Connections and other extensions are available on Pro. Upgrade to connect your database and unlock extensions."}
                  </DialogDescription>
                </DialogHeader>
                <div className="pt-2">
                  <Button
                    size="sm"
                    onClick={() => {
                      if (!isAuthenticated) {
                        setShowExtensionsGateDialog(false);
                        navigate({ to: "/sign-in" });
                      } else {
                        setShowExtensionsGateDialog(false);
                        triggerUpgrade();
                      }
                    }}
                  >
                    {!isAuthenticated ? "Log in" : "Upgrade"}
                  </Button>
                </div>
              </DialogContent>
            </Dialog>
            <ExtensionManagerDialog
              open={isExtensionManagerOpen}
              onOpenChange={setIsExtensionManagerOpen}
              activeExtensionIds={activeExtensionIds}
              onAddToPanel={(id) => {
                if (activeExtensionIds.includes(id)) return;
                if (activeExtensionIds.length >= 5) return;
                setActiveExtensionIds([...activeExtensionIds, id]);
                setSelectedExtensionId(id);
              }}
            />
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
                    data-onboarding={item.title === "Diagram" ? "blueprint-tab" : item.title === "Settings" ? "settings-link" : undefined}
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
