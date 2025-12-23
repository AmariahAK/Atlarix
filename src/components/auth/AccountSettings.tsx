/**
 * Atlarix Account Settings
 * ========================
 * User profile, plan status, and device management
 */

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Separator } from "@/components/ui/separator";
import { LogOut, Monitor, Trash2 } from "lucide-react";
import type { User, Subscription, Device } from "@/lib/auth/types";

interface AccountSettingsProps {
    user: User;
    subscription: Subscription;
    devices: Device[];
    onSignOut: () => void;
    onRemoveDevice: (deviceId: string) => void;
    onUpgrade: () => void;
}

export function AccountSettings({
    user,
    subscription,
    devices,
    onSignOut,
    onRemoveDevice,
    onUpgrade,
}: AccountSettingsProps) {
    const getPlanBadge = () => {
        switch (subscription.plan) {
            case "free":
                return <Badge variant="secondary">Free</Badge>;
            case "monthly":
                return <Badge className="bg-primary">Pro Monthly</Badge>;
            case "annual_sub":
                return <Badge className="bg-primary">Pro Annual</Badge>;
            case "annual_license":
                return <Badge className="bg-secondary">V1 License</Badge>;
            default:
                return <Badge>Unknown</Badge>;
        }
    };

    const formatDate = (date: Date) => {
        return new Intl.DateTimeFormat("en-US", {
            year: "numeric",
            month: "long",
            day: "numeric",
        }).format(date);
    };

    const getInitials = (name: string) => {
        return name
            .split(" ")
            .map(n => n[0])
            .join("")
            .toUpperCase()
            .slice(0, 2);
    };

    return (
        <div className="space-y-6 max-w-2xl mx-auto p-6">
            {/* Profile Card */}
            <Card>
                <CardHeader>
                    <CardTitle>Profile</CardTitle>
                    <CardDescription>Your Atlarix account information</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="flex items-center gap-4">
                        <Avatar className="h-16 w-16">
                            <AvatarImage src={user.avatar} alt={user.name} />
                            <AvatarFallback className="bg-primary text-primary-foreground">
                                {getInitials(user.name)}
                            </AvatarFallback>
                        </Avatar>

                        <div className="flex-1">
                            <h3 className="font-semibold text-lg">{user.name}</h3>
                            <p className="text-sm text-muted-foreground">{user.email}</p>
                            <div className="flex items-center gap-2 mt-2">
                                <Badge variant="outline" className="text-xs">
                                    {user.oauth_provider === "google" ? "Google" : "GitHub"}
                                </Badge>
                                <span className="text-xs text-muted-foreground">
                                    Joined {formatDate(new Date(user.createdAt))}
                                </span>
                            </div>
                        </div>
                    </div>

                    <Button onClick={onSignOut} variant="outline" className="w-full">
                        <LogOut className="h-4 w-4 mr-2" />
                        Sign Out
                    </Button>
                </CardContent>
            </Card>

            {/* Subscription Card */}
            <Card>
                <CardHeader>
                    <CardTitle>Subscription</CardTitle>
                    <CardDescription>Your current plan and status</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="flex items-center justify-between">
                        <div>
                            <p className="font-medium">Current Plan</p>
                            <div className="flex items-center gap-2 mt-1">
                                {getPlanBadge()}
                                <Badge
                                    variant={subscription.status === "active" ? "outline" : "destructive"}
                                    className="text-xs"
                                >
                                    {subscription.status}
                                </Badge>
                            </div>
                        </div>

                        {subscription.plan === "free" && (
                            <Button onClick={onUpgrade} className="atlarix-glow">
                                Upgrade to Pro
                            </Button>
                        )}
                    </div>

                    {subscription.plan === "free" && subscription.status === "active" && (
                        <div className="rounded-lg bg-muted p-3">
                            <p className="text-sm font-medium">Free Tier Limits:</p>
                            <ul className="text-sm text-muted-foreground mt-2 space-y-1">
                                <li>• 5 prompts per day</li>
                                <li>• 1 active project</li>
                                <li>• Community support</li>
                            </ul>
                        </div>
                    )}

                    {subscription.plan !== "free" && (
                        <>
                            <Separator />

                            <div className="space-y-2 text-sm">
                                <div className="flex justify-between">
                                    <span className="text-muted-foreground">Access:</span>
                                    <span className="font-medium">
                                        {subscription.versions.length > 1
                                            ? "All versions"
                                            : `Version ${subscription.versions[0]}`}
                                    </span>
                                </div>

                                {subscription.currentPeriodEnd && (
                                    <div className="flex justify-between">
                                        <span className="text-muted-foreground">
                                            {subscription.plan.includes("annual") ? "Renews:" : "Next billing:"}
                                        </span>
                                        <span className="font-medium">
                                            {formatDate(new Date(subscription.currentPeriodEnd))}
                                        </span>
                                    </div>
                                )}
                            </div>
                        </>
                    )}
                </CardContent>
            </Card>

            {/* Devices Card */}
            <Card>
                <CardHeader>
                    <CardTitle>Devices</CardTitle>
                    <CardDescription>
                        {devices.length}/5 devices active
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                    {devices.length === 0 ? (
                        <p className="text-sm text-muted-foreground">No devices registered</p>
                    ) : (
                        devices.map((device) => (
                            <div
                                key={device.id}
                                className="flex items-center justify-between p-3 rounded-lg border"
                            >
                                <div className="flex items-center gap-3">
                                    <Monitor className="h-5 w-5 text-muted-foreground" />
                                    <div>
                                        <p className="font-medium text-sm">{device.deviceName}</p>
                                        <p className="text-xs text-muted-foreground">
                                            {device.os} • Last active {formatDate(new Date(device.lastActive))}
                                        </p>
                                    </div>
                                </div>

                                <Button
                                    onClick={() => onRemoveDevice(device.deviceId)}
                                    variant="ghost"
                                    size="sm"
                                    className="text-destructive hover:text-destructive"
                                >
                                    <Trash2 className="h-4 w-4" />
                                </Button>
                            </div>
                        ))
                    )}

                    {devices.length >= 5 && (
                        <div className="rounded-lg bg-destructive/10 border border-destructive/50 p-3">
                            <p className="text-sm text-destructive font-medium">
                                Device limit reached
                            </p>
                            <p className="text-xs text-muted-foreground mt-1">
                                Remove a device to add a new one
                            </p>
                        </div>
                    )}
                </CardContent>
            </Card>
        </div>
    );
}
