import {
  BadRequestException,
  Controller,
  Get,
  Injectable,
  NotFoundException,
  Param,
  Query,
  Res,
} from "@nestjs/common";
import { RESTRICTED_PLAN_COUNTRY_CODES } from "@visa-compass/shared";
import type { Response } from "express";
import { PrismaService } from "../../infrastructure/prisma.service.js";
export type CatalogPlan = {
  id: string;
  countryCode: string;
  countryName: string;
  name: string;
  dataAllowance: string;
  allowanceMb?: number | null;
  validityDays: number;
  sellingPriceNpr: number;
  coverage: string[];
  popular: boolean;
};
const localE2ePlans: CatalogPlan[] = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    countryCode: "IN",
    countryName: "India",
    name: "India Essential 1 GB",
    dataAllowance: "1 GB",
    allowanceMb: 1024,
    validityDays: 7,
    sellingPriceNpr: 999,
    coverage: ["IN"],
    popular: true,
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    countryCode: "AU",
    countryName: "Australia",
    name: "Australia Essential 3 GB",
    dataAllowance: "3 GB",
    allowanceMb: 3072,
    validityDays: 15,
    sellingPriceNpr: 2499,
    coverage: ["AU"],
    popular: false,
  },
];
const useLocalE2eCatalog = () =>
  process.env.NODE_ENV === "test" &&
  process.env.E2E_AUTH_ENABLED === "true" &&
  process.env.PERSISTENCE_MODE === "memory";

export function parseDataAllowanceMb(value: string): number | null {
  const normalized = value.trim().replace(/,/g, "");
  const match = normalized.match(/(\d+(?:\.\d+)?)\s*(KB|MB|GB|TB)\b/i);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;
  const multiplier =
    match[2]?.toUpperCase() === "TB"
      ? 1024 * 1024
      : match[2]?.toUpperCase() === "GB"
        ? 1024
        : match[2]?.toUpperCase() === "KB"
          ? 1 / 1024
          : 1;
  return Math.round(amount * multiplier);
}
export function normalizePlanName(name: string, dataAllowance: string) {
  let normalized = name
    .replace(/\bUsa\b/g, "USA")
    .replace(/\bSim\b/g, "eSIM")
    .replace(/(\d+(?:\.\d+)?)\s*(KB|MB|GB|TB)\b/gi, "$1 $2");
  if (/unlimited\s+data/i.test(normalized) && parseDataAllowanceMb(dataAllowance)) {
    const allowance = dataAllowance
      .trim()
      .replace(/(\d+(?:\.\d+)?)\s*(KB|MB|GB|TB)\b/gi, "$1 $2");
    const withoutClaim = normalized.replace(/unlimited\s+data/gi, "").trim();
    const compact = (value: string) => value.replace(/\s+/g, "").toLowerCase();
    normalized = compact(withoutClaim).includes(compact(allowance))
      ? withoutClaim
      : normalized.replace(/unlimited\s+data/gi, allowance);
  }
  return normalized.replace(/\s+/g, " ").trim();
}

const CANONICAL_COUNTRY_NAMES: Record<string, string> = {
  CI: "Côte d’Ivoire",
  US: "United States",
  GB: "United Kingdom",
};
const isoCodeFilter = (country?: string) => {
  const filter: Record<string, string | string[]> = {};
  if (RESTRICTED_PLAN_COUNTRY_CODES.length)
    filter.notIn = [...RESTRICTED_PLAN_COUNTRY_CODES];
  if (country) filter.equals = country.toUpperCase();
  return Object.keys(filter).length ? { isoCode: filter } : {};
};
@Injectable()
export class CatalogService {
  constructor(private readonly prisma: PrismaService) {}
  private summary(plan: {
    id: string;
    name: string;
    dataAllowance: string;
    validityDays: number;
    sellingPrice: unknown;
    coverage: unknown;
    popular: boolean;
    country: { isoCode: string; name: string };
  }): CatalogPlan {
    return {
      id: plan.id,
      countryCode: plan.country.isoCode,
      countryName: CANONICAL_COUNTRY_NAMES[plan.country.isoCode] ?? plan.country.name,
      name: normalizePlanName(plan.name, plan.dataAllowance),
      dataAllowance: plan.dataAllowance,
      allowanceMb: parseDataAllowanceMb(plan.dataAllowance),
      validityDays: plan.validityDays,
      sellingPriceNpr: Number(plan.sellingPrice),
      coverage: Array.isArray(plan.coverage) ? (plan.coverage as string[]) : [],
      popular: plan.popular,
    };
  }
  async plans(
    country?: string,
    options: { popularOnly?: boolean; limit?: number } = {},
  ) {
    if (!this.prisma.enabled) {
      if (!useLocalE2eCatalog()) return [];
      return localE2ePlans
        .filter((plan) => !country || plan.countryCode === country.toUpperCase())
        .filter((plan) => !options.popularOnly || plan.popular)
        .slice(0, options.limit);
    }
    const rows = await this.prisma.plan.findMany({
      where: {
        status: "ACTIVE",
        ...(options.popularOnly ? { popular: true } : {}),
        country: { active: true, ...isoCodeFilter(country) },
      },
      include: { country: true },
      orderBy: [{ popular: "desc" }, { sellingPrice: "asc" }],
      ...(options.limit ? { take: options.limit } : {}),
    });
    return rows.map((plan) => this.summary(plan));
  }
  async findActive(id: string) {
    if (!this.prisma.enabled)
      return useLocalE2eCatalog()
        ? localE2ePlans.find((plan) => plan.id === id)
        : undefined;
    const plan = await this.prisma.plan.findFirst({
      where: {
        id,
        status: "ACTIVE",
        country: { active: true, ...isoCodeFilter() },
      },
      include: { country: true },
    });
    return plan ? this.summary(plan) : undefined;
  }
  async countries() {
    if (!this.prisma.enabled) {
      if (!useLocalE2eCatalog()) return [];
      return [...new Map(
        localE2ePlans.map((plan) => [
          plan.countryCode,
          {
            code: plan.countryCode,
            name: plan.countryName,
            popular: localE2ePlans.some(
              (candidate) =>
                candidate.countryCode === plan.countryCode && candidate.popular,
            ),
          },
        ]),
      ).values()].sort((a, b) => a.name.localeCompare(b.name));
    }
    const countries = await this.prisma.country.findMany({
      where: {
        active: true,
        ...isoCodeFilter(),
        plans: { some: { status: "ACTIVE" } },
      },
      select: {
        isoCode: true,
        name: true,
        plans: {
          where: { status: "ACTIVE", popular: true },
          select: { id: true },
          take: 1,
        },
      },
      orderBy: { name: "asc" },
    });
    return countries.map((country) => ({
      code: country.isoCode,
      name: CANONICAL_COUNTRY_NAMES[country.isoCode] ?? country.name,
      popular: country.plans.length > 0,
    }));
  }
}
@Controller("public")
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}
  @Get("countries") countries(@Res({ passthrough: true }) response: Response) {
    response.setHeader("Cache-Control", "public, max-age=30, stale-while-revalidate=60");
    response.vary("Origin");
    return this.catalog.countries();
  }
  @Get("plans") plans(
    @Query("country") country?: string,
    @Query("popular") popular?: string,
    @Query("limit") requestedLimit?: string,
  ) {
    if (popular && popular !== "true" && popular !== "false")
      throw new BadRequestException("popular must be true or false");
    const parsedLimit = requestedLimit ? Number(requestedLimit) : undefined;
    if (
      parsedLimit !== undefined &&
      (!Number.isInteger(parsedLimit) || parsedLimit < 1)
    )
      throw new BadRequestException("limit must be a positive integer");
    return this.catalog.plans(country, {
      popularOnly: popular === "true",
      ...(parsedLimit !== undefined
        ? { limit: Math.min(parsedLimit, 24) }
        : {}),
    });
  }
  @Get("plans/:id") async plan(@Param("id") id: string) {
    const plan = await this.catalog.findActive(id);
    if (!plan) throw new NotFoundException("Plan not found");
    return plan;
  }
  @Get("coverage/:country") async coverage(@Param("country") country: string) {
    const available = (await this.catalog.plans(country)).length > 0;
    return {
      available,
      message: available
        ? "Coverage available"
        : "Coverage is unavailable. Please contact Visa Compass for assistance.",
    };
  }
}
