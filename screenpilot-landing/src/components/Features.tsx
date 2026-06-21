"use client";

import { motion } from "framer-motion";
import {
  Camera,
  ListChecks,
  RefreshCw,
  ScanSearch,
  Globe,
  Brain,
  Crosshair,
  History,
} from "lucide-react";

const features = [
  {
    icon: Camera,
    title: "Screenshot-based understanding",
    description:
      "ScreenPilot captures the current tab visually and sends it to Gemini. It sees the page the same way you do — not just the HTML.",
  },
  {
    icon: ListChecks,
    title: "One step at a time",
    description:
      "Never dumps a full list on you. Each highlight is one action. After you click, it reassesses and shows the next one.",
  },
  {
    icon: RefreshCw,
    title: "Recalculates after every click",
    description:
      "Page changes after an action trigger a new screenshot and a new analysis automatically. You don't press anything — it just continues.",
  },
  {
    icon: ScanSearch,
    title: "Finds elements without fragile selectors",
    description:
      "Matches elements by visible text, aria-label, role, and position scoring — not hardcoded CSS selectors that break on every redesign.",
  },
  {
    icon: Globe,
    title: "Any website, out of the box",
    description:
      "There's no per-site configuration. It works on Gmail the same way it works on your internal HR tool or a university portal.",
  },
  {
    icon: Brain,
    title: "Tracks where you are in the workflow",
    description:
      "Completed steps are remembered. If the page reloads or navigation resets, ScreenPilot picks up from where it left off.",
  },
  {
    icon: Crosshair,
    title: "Arrow + ring + instruction bubble",
    description:
      "Three visual layers on the target element: a spotlight, a pulsing border ring, and a floating instruction bubble with the action to take.",
  },
  {
    icon: History,
    title: "Knows what it already did",
    description:
      "Completed steps are passed back with every new request so Gemini never suggests repeating an action you've already taken.",
  },
];

export default function Features() {
  return (
    <section
      id="features"
      className="relative py-32 bg-[#F8FAFC] border-t border-black/[0.05]"
    >
      <div className="max-w-[1280px] mx-auto px-6">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
          className="text-center max-w-2xl mx-auto mb-16"
        >
          <p className="text-[11px] text-[#2563EB] uppercase tracking-[0.12em] font-semibold mb-4">
            Capabilities
          </p>
          <h2 className="text-4xl md:text-5xl font-bold text-[#0F172A] tracking-tight mb-4">
            What&apos;s under the surface
          </h2>
          <p className="text-[#64748B] text-lg leading-relaxed">
            The highlight you see is simple. The machinery behind it isn&apos;t.
          </p>
        </motion.div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {features.map((feature, i) => {
            const Icon = feature.icon;
            return (
              <motion.div
                key={feature.title}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.4, delay: i * 0.06 }}
                className="group p-6 rounded-xl bg-white border border-black/[0.06] hover:border-[#2563EB]/20 hover:shadow-sm transition-all duration-300"
              >
                <div className="w-9 h-9 rounded-lg bg-[#F8FAFC] border border-black/[0.07] flex items-center justify-center mb-4 group-hover:border-[#2563EB]/25 group-hover:bg-[#EBF3FE] transition-all duration-300">
                  <Icon className="w-4 h-4 text-[#64748B] group-hover:text-[#2563EB] transition-colors duration-300" />
                </div>
                <h3 className="font-semibold text-[#0F172A] text-sm mb-2">
                  {feature.title}
                </h3>
                <p className="text-[#64748B] text-xs leading-relaxed">
                  {feature.description}
                </p>
              </motion.div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
