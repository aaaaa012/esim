"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Eye,
  ImageIcon,
  LayoutTemplate,
  Pencil,
  Plus,
  Save,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { useAuthenticatedFetch } from "../../authenticated-api-provider";
import { EmptyState } from "@/components/empty-state";
import { FileUploader } from "@/components/file-uploader";
import { PageHeader } from "@/components/page-header";
import { Panel } from "@/components/panel";
import { Spinner } from "@/components/spinner";
import { StatusBadge, type StatusTone } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1";
const CUSTOMER_WEB = process.env.NEXT_PUBLIC_CUSTOMER_WEB_URL;
const NEPAL_OFFSET_MS = (5 * 60 + 45) * 60 * 1000;

type Placement =
  "FEATURED_BANNER" | "OFFER_GALLERY" | "HOW_GUIDE" | "WHY_ESIM_BANNER";
type Format = "PORTRAIT" | "SQUARE" | "LANDSCAPE";
type Campaign = {
  id: string;
  title: string;
  altText: string;
  imageUrl: string;
  assetKey: string | null;
  placement: Placement;
  format: Format;
  imageWidth: number;
  imageHeight: number;
  countryCode: string | null;
  ctaLabel: string;
  sortOrder: number;
  active: boolean;
  startsAt: string | null;
  endsAt: string | null;
  createdAt: string;
  updatedAt: string;
};
type Country = { code: string; name: string };
type UploadedArtwork = {
  assetKey: string;
  imageUrl: string;
  width: number;
  height: number;
  format: Format;
};
type FormState = {
  title: string;
  altText: string;
  placement: Placement;
  countryCode: string;
  ctaLabel: string;
  sortOrder: string;
  active: boolean;
  startsAt: string;
  endsAt: string;
};

const placements: Array<{ value: Placement; label: string; hint: string }> = [
  {
    value: "FEATURED_BANNER",
    label: "Featured banner",
    hint: "Primary landscape slot below the hero",
  },
  {
    value: "OFFER_GALLERY",
    label: "Offer gallery",
    hint: "Scrollable multi-campaign gallery",
  },
  {
    value: "HOW_GUIDE",
    label: "How-to guide",
    hint: "Image beside the three setup steps",
  },
  {
    value: "WHY_ESIM_BANNER",
    label: "Why eSIM banner",
    hint: "Partnership summary above benefit cards",
  },
];

const initialForm: FormState = {
  title: "",
  altText: "",
  placement: "OFFER_GALLERY",
  countryCode: "",
  ctaLabel: "Browse travel plans",
  sortOrder: "0",
  active: true,
  startsAt: "",
  endsAt: "",
};

export function kathmanduInputToUtc(value: string) {
  return value ? new Date(`${value}:00+05:45`).toISOString() : null;
}

export function utcToKathmanduInput(value: string | null) {
  if (!value) return "";
  return new Date(new Date(value).getTime() + NEPAL_OFFSET_MS)
    .toISOString()
    .slice(0, 16);
}

function campaignStatus(campaign: Campaign): {
  label: string;
  tone: StatusTone;
} {
  const now = Date.now();
  if (!campaign.active) return { label: "Hidden", tone: "default" };
  if (campaign.startsAt && new Date(campaign.startsAt).getTime() > now)
    return { label: "Scheduled", tone: "info" };
  if (campaign.endsAt && new Date(campaign.endsAt).getTime() <= now)
    return { label: "Expired", tone: "warning" };
  return { label: "Live", tone: "success" };
}

function customerOrigin() {
  if (CUSTOMER_WEB) return CUSTOMER_WEB.replace(/\/$/, "");
  if (typeof window !== "undefined" && window.location.hostname.startsWith("ops."))
    return `${window.location.protocol}//${window.location.hostname.replace(/^ops\./, "esim.")}`;
  return "http://localhost:3000";
}

export function resolveCampaignArtwork(imageUrl: string) {
  if (imageUrl.startsWith("/api/v1/")) {
    try {
      return `${new URL(API).origin}${imageUrl}`;
    } catch {
      return imageUrl;
    }
  }
  return imageUrl.startsWith("/") ? `${customerOrigin()}${imageUrl}` : imageUrl;
}

function apiError(value: unknown, fallback: string) {
  if (!value || typeof value !== "object") return fallback;
  const payload = value as {
    message?: string;
    correlationId?: string;
    error?: string | { message?: string; correlationId?: string };
  };
  const message =
    payload.message ??
    (typeof payload.error === "string" ? payload.error : payload.error?.message) ??
    fallback;
  const correlationId =
    payload.correlationId ??
    (typeof payload.error === "object" ? payload.error?.correlationId : undefined) ??
    (value as { meta?: { correlationId?: string } }).meta?.correlationId;
  return correlationId ? `${message} (reference ${correlationId})` : message;
}

function Artwork({ campaign }: { campaign: Campaign }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [campaign.imageUrl]);
  if (broken)
    return (
      <span className="flex size-full flex-col items-center justify-center gap-2 bg-muted p-5 text-center text-xs text-muted-foreground">
        <ImageIcon className="size-6" aria-hidden="true" />
        Artwork unavailable
      </span>
    );
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={resolveCampaignArtwork(campaign.imageUrl)}
      alt={campaign.altText}
      className="max-h-[34rem] size-full object-contain"
      loading="lazy"
      onError={() => setBroken(true)}
    />
  );
}

export default function HomepageCampaignsClient() {
  const authFetch = useAuthenticatedFetch();
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [countries, setCountries] = useState<Country[]>([]);
  const [form, setForm] = useState<FormState>(initialForm);
  const [file, setFile] = useState<File | null>(null);
  const [editing, setEditing] = useState<Campaign | null>(null);
  const [previewing, setPreviewing] = useState<Campaign | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadPhase, setUploadPhase] = useState("");
  const filePreview = useMemo(
    () => (file ? URL.createObjectURL(file) : ""),
    [file],
  );

  useEffect(
    () => () => {
      if (filePreview) URL.revokeObjectURL(filePreview);
    },
    [filePreview],
  );

  const request = useCallback(
    async <T,>(path: string, init?: RequestInit) => {
      const response = await authFetch(`${API}${path}`, {
        ...init,
        headers: {
          ...(init?.body instanceof FormData ? {} : { "content-type": "application/json" }),
          ...init?.headers,
        },
      });
      const value = await response.json();
      if (!response.ok) throw new Error(apiError(value, "Request failed"));
      return value.data as T;
    },
    [authFetch],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [campaignItems, countryItems] = await Promise.all([
        request<Campaign[]>("/admin/homepage-campaigns"),
        request<Country[]>("/public/countries"),
      ]);
      setCampaigns(campaignItems);
      setCountries(countryItems);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Campaigns could not be loaded",
      );
    } finally {
      setLoading(false);
    }
  }, [request]);

  useEffect(() => {
    void load();
  }, [load]);

  const updateForm = <Key extends keyof FormState>(
    key: Key,
    value: FormState[Key],
  ) => setForm((current) => ({ ...current, [key]: value }));

  const reset = () => {
    setEditing(null);
    setFile(null);
    setForm(initialForm);
    setUploadProgress(0);
    setUploadPhase("");
  };

  const edit = (campaign: Campaign) => {
    setEditing(campaign);
    setFile(null);
    setForm({
      title: campaign.title,
      altText: campaign.altText,
      placement: campaign.placement,
      countryCode: campaign.countryCode ?? "",
      ctaLabel: campaign.ctaLabel,
      sortOrder: String(campaign.sortOrder),
      active: campaign.active,
      startsAt: utcToKathmanduInput(campaign.startsAt),
      endsAt: utcToKathmanduInput(campaign.endsAt),
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const save = async () => {
    if (
      !form.title.trim() ||
      form.altText.trim().length < 12 ||
      !form.ctaLabel.trim()
    ) {
      toast.error("Add a title, descriptive alt text, and CTA label");
      return;
    }
    if (!editing && !file) {
      toast.error("Choose JPG or PNG artwork first");
      return;
    }
    if (
      file &&
      (file.size > 3 * 1024 * 1024 ||
        !["image/jpeg", "image/png"].includes(file.type))
    ) {
      toast.error("Artwork must be a JPG or PNG up to 3 MB");
      return;
    }
    setBusy(true);
    setUploadProgress(file ? 2 : 100);
    setUploadPhase(file ? "Validating artwork" : "Saving campaign");
    try {
      let assetKey: string | undefined;
      if (file) {
        const body = new FormData();
        body.append("artwork", file);
        setUploadProgress(20);
        setUploadPhase("Uploading securely");
        const uploaded = await request<UploadedArtwork>(
          "/admin/homepage-campaigns/uploads",
          { method: "POST", body },
        );
        setUploadProgress(82);
        setUploadPhase("Artwork verified");
        assetKey = uploaded.assetKey;
      }
      const payload = {
        title: form.title.trim(),
        altText: form.altText.trim(),
        placement: form.placement,
        countryCode: form.countryCode || null,
        ctaLabel: form.ctaLabel.trim(),
        sortOrder: Number(form.sortOrder) || 0,
        active: form.active,
        startsAt: kathmanduInputToUtc(form.startsAt),
        endsAt: kathmanduInputToUtc(form.endsAt),
        ...(assetKey ? { assetKey } : {}),
      };
      setUploadProgress(94);
      setUploadPhase("Saving campaign");
      await request(
        editing
          ? `/admin/homepage-campaigns/${editing.id}`
          : "/admin/homepage-campaigns",
        { method: editing ? "PATCH" : "POST", body: JSON.stringify(payload) },
      );
      setUploadProgress(100);
      setUploadPhase("Complete");
      toast.success(editing ? "Campaign updated" : "Campaign created");
      reset();
      await load();
    } catch (error) {
      setUploadPhase("Upload failed");
      toast.error(
        error instanceof Error ? error.message : "Campaign could not be saved",
      );
    } finally {
      setBusy(false);
    }
  };

  const remove = async (campaign: Campaign) => {
    if (!confirm(`Delete “${campaign.title}”? This cannot be undone.`)) return;
    try {
      await request(`/admin/homepage-campaigns/${campaign.id}`, {
        method: "DELETE",
      });
      setCampaigns((items) => items.filter((item) => item.id !== campaign.id));
      toast.success("Campaign deleted");
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Campaign could not be deleted",
      );
    }
  };

  return (
    <>
      <PageHeader
        title="Homepage campaigns"
        description="Control homepage artwork, placement, visibility, and Nepal-time schedules. Changes appear on the customer homepage when active."
        badge={
          <StatusBadge
            label={`${campaigns.filter((item) => campaignStatus(item).label === "Live").length} live`}
            tone="success"
          />
        }
      />

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(360px,0.86fr)_minmax(0,1.5fr)]">
        <div className="space-y-6">
          <Panel
            title={editing ? "Edit campaign" : "New campaign"}
            description="JPG or PNG, maximum 3 MB. Dates use Asia/Kathmandu time."
          >
            <div className="space-y-4">
              <FileUploader
                accept="image/jpeg,image/png"
                hint="JPG or PNG · up to 3 MB"
                value={file}
                busy={busy}
                onFileSelected={setFile}
              />
              {(filePreview || editing) && (
                <button
                  type="button"
                  className="relative block min-h-64 w-full overflow-hidden rounded-lg border bg-muted p-2"
                  onClick={() =>
                    editing && !filePreview && setPreviewing(editing)
                  }
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={
                      filePreview ||
                      resolveCampaignArtwork(editing!.imageUrl)
                    }
                    alt="Campaign artwork preview"
                    className="size-full object-contain"
                  />
                </button>
              )}
              {busy && (
                <div className="space-y-1">
                  <Progress value={uploadProgress} />
                  <p className="text-xs text-muted-foreground">
                    {uploadPhase} · {uploadProgress}%
                  </p>
                </div>
              )}
              <Field label="Campaign title">
                <Input
                  value={form.title}
                  onChange={(event) => updateForm("title", event.target.value)}
                  placeholder="e.g. Japan travel eSIM offer"
                />
              </Field>
              <Field
                label="Descriptive alt text"
                hint="Required for customers who cannot see the artwork."
              >
                <textarea
                  className="flex min-h-24 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  value={form.altText}
                  onChange={(event) =>
                    updateForm("altText", event.target.value)
                  }
                  placeholder="Describe the visual and the useful offer context."
                />
              </Field>
              <Field label="Homepage placement">
                <select
                  className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  value={form.placement}
                  onChange={(event) =>
                    updateForm("placement", event.target.value as Placement)
                  }
                >
                  {placements.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-muted-foreground">
                  {
                    placements.find((item) => item.value === form.placement)
                      ?.hint
                  }
                </p>
              </Field>
              <Field label="Destination (optional)">
                <select
                  className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  value={form.countryCode}
                  onChange={(event) =>
                    updateForm("countryCode", event.target.value)
                  }
                >
                  <option value="">General campaign</option>
                  {countries.map((country) => (
                    <option key={country.code} value={country.code}>
                      {country.name} ({country.code})
                    </option>
                  ))}
                </select>
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="CTA label">
                  <Input
                    value={form.ctaLabel}
                    onChange={(event) =>
                      updateForm("ctaLabel", event.target.value)
                    }
                  />
                </Field>
                <Field label="Sort order">
                  <Input
                    type="number"
                    min="0"
                    max="9999"
                    value={form.sortOrder}
                    onChange={(event) =>
                      updateForm("sortOrder", event.target.value)
                    }
                  />
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Starts (Nepal time)">
                  <Input
                    type="datetime-local"
                    value={form.startsAt}
                    onChange={(event) =>
                      updateForm("startsAt", event.target.value)
                    }
                  />
                </Field>
                <Field label="Ends (Nepal time)">
                  <Input
                    type="datetime-local"
                    value={form.endsAt}
                    onChange={(event) =>
                      updateForm("endsAt", event.target.value)
                    }
                  />
                </Field>
              </div>
              <div className="flex items-center justify-between rounded-lg border p-3">
                <div>
                  <p className="text-sm font-medium">Visible</p>
                  <p className="text-xs text-muted-foreground">
                    Schedule rules still apply.
                  </p>
                </div>
                <Switch
                  checked={form.active}
                  onCheckedChange={(checked) => updateForm("active", checked)}
                />
              </div>
              <div className="flex gap-2">
                {editing && (
                  <Button variant="outline" className="flex-1" onClick={reset}>
                    <X className="size-4" /> Cancel
                  </Button>
                )}
                <Button
                  className="flex-1"
                  disabled={busy}
                  onClick={() => void save()}
                >
                  {busy ? (
                    <Spinner className="text-primary-foreground" />
                  ) : editing ? (
                    <Save className="size-4" />
                  ) : (
                    <Plus className="size-4" />
                  )}
                  {editing ? "Save changes" : "Create campaign"}
                </Button>
              </div>
            </div>
          </Panel>

          <Panel
            title="Homepage layout preview"
            description="The highlighted area is the selected placement."
          >
            <div className="space-y-2 rounded-xl border bg-muted/30 p-3">
              <div className="h-9 rounded-md bg-slate-900/90" />
              <Slot
                active={form.placement === "FEATURED_BANNER"}
                label="Featured banner"
                landscape
              />
              <Slot
                active={form.placement === "OFFER_GALLERY"}
                label="Offer gallery"
              />
              <div className="grid grid-cols-2 gap-2">
                <Slot
                  active={form.placement === "HOW_GUIDE"}
                  label="How guide"
                />
                <div className="rounded-md border bg-background p-3 text-center text-[10px] text-muted-foreground">
                  HTML steps
                </div>
              </div>
              <Slot
                active={form.placement === "WHY_ESIM_BANNER"}
                label="Why eSIM banner"
                landscape
              />
            </div>
          </Panel>
        </div>

        <Panel
          title="Configured campaigns"
          description={`${campaigns.length} campaign(s) across four homepage slots.`}
        >
          {loading ? (
            <div className="flex min-h-64 items-center justify-center">
              <Spinner />
            </div>
          ) : !campaigns.length ? (
            <EmptyState
              title="No homepage campaigns"
              description="Upload the first approved campaign artwork to populate a homepage slot."
            />
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              {campaigns.map((campaign) => {
                const status = campaignStatus(campaign);
                return (
                  <article
                    key={campaign.id}
                    className="overflow-hidden rounded-xl border bg-card shadow-sm"
                  >
                    <button
                      type="button"
                      className="block min-h-72 w-full overflow-hidden border-b bg-muted p-2"
                      onClick={() => setPreviewing(campaign)}
                      aria-label={`Preview ${campaign.title}`}
                    >
                      <Artwork campaign={campaign} />
                    </button>
                    <div className="space-y-3 p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <h3 className="font-semibold leading-tight">
                            {campaign.title}
                          </h3>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {
                              placements.find(
                                (item) => item.value === campaign.placement,
                              )?.label
                            }{" "}
                            · {campaign.format.toLowerCase()} ·{" "}
                            {campaign.imageWidth}×{campaign.imageHeight}
                          </p>
                        </div>
                        <StatusBadge label={status.label} tone={status.tone} />
                      </div>
                      <p className="line-clamp-2 text-xs text-muted-foreground">
                        {campaign.altText}
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setPreviewing(campaign)}
                        >
                          <Eye className="size-4" /> Preview
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => edit(campaign)}
                        >
                          <Pencil className="size-4" /> Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="text-destructive"
                          onClick={() => void remove(campaign)}
                        >
                          <Trash2 className="size-4" /> Delete
                        </Button>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </Panel>
      </div>

      <Dialog
        open={Boolean(previewing)}
        onOpenChange={(open) => !open && setPreviewing(null)}
      >
        <DialogContent className="max-h-[92vh] max-w-5xl overflow-auto">
          <DialogHeader>
            <DialogTitle>{previewing?.title}</DialogTitle>
            <DialogDescription>
              Full-size homepage artwork preview
            </DialogDescription>
          </DialogHeader>
          {previewing && (
            <div className="flex justify-center rounded-lg bg-muted p-3">
              <Artwork campaign={previewing} />
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setPreviewing(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function Slot({
  active,
  label,
  landscape,
}: {
  active: boolean;
  label: string;
  landscape?: boolean;
}) {
  return (
    <div
      className={`flex items-center justify-center rounded-md border p-3 text-[10px] font-semibold transition-colors ${landscape ? "min-h-12" : "min-h-20"} ${active ? "border-primary bg-primary/10 text-primary ring-2 ring-primary/20" : "bg-background text-muted-foreground"}`}
    >
      {active ? (
        <LayoutTemplate className="mr-1 size-3" />
      ) : (
        <ImageIcon className="mr-1 size-3" />
      )}
      {label}
    </div>
  );
}
