import {
  Controller,
  Get,
  Injectable,
  NotFoundException,
  Param,
  Query,
} from "@nestjs/common";
import { RESTRICTED_PLAN_COUNTRY_CODES } from "@visa-compass/shared";
import { PrismaService } from "../../infrastructure/prisma.service.js";
export type CatalogPlan = {
  id: string;
  countryCode: string;
  countryName: string;
  name: string;
  dataAllowance: string;
  validityDays: number;
  sellingPriceNpr: number;
  coverage: string[];
  popular: boolean;
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
      countryName: plan.country.name,
      name: plan.name,
      dataAllowance: plan.dataAllowance,
      validityDays: plan.validityDays,
      sellingPriceNpr: Number(plan.sellingPrice),
      coverage: Array.isArray(plan.coverage) ? (plan.coverage as string[]) : [],
      popular: plan.popular,
    };
  }
  async plans(country?: string) {
    if (!this.prisma.enabled) return [];
    const rows = await this.prisma.plan.findMany({
      where: {
        status: "ACTIVE",
        country: { active: true, ...isoCodeFilter(country) },
      },
      include: { country: true },
      orderBy: [{ popular: "desc" }, { sellingPrice: "asc" }],
    });
    return rows.map((plan) => this.summary(plan));
  }
  async findActive(id: string) {
    if (!this.prisma.enabled) return undefined;
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
    if (!this.prisma.enabled) return [];
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
      name: country.name,
      popular: country.plans.length > 0,
    }));
  }
}
@Controller("public")
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}
  @Get("countries") countries() {
    return this.catalog.countries();
  }
  @Get("plans") plans(@Query("country") country?: string) {
    return this.catalog.plans(country);
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
