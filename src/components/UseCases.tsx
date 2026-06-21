"use client";

import { motion } from "framer-motion";
import {
  Mail,
  GitBranch,
  FileText,
  Ticket,
  Table2,
  GraduationCap,
  Building2,
  Globe,
} from "lucide-react";

const cases = [
  {
    icon: Mail,
    name: "Gmail",
    category: "Email",
    example: "\"Compose an email to Sarah about the project update\"",
    detail: "Compose → To → Subject → Body → Send",
  },
  {
    icon: GitBranch,
    name: "GitHub",
    category: "Dev Tools",
    example: "\"Create an issue about the broken payment flow\"",
    detail: "Issues → New issue → Fill form → Submit",
  },
  {
    icon: FileText,
    name: "Notion",
    category: "Docs",
    example: "\"Create a new database and share it with the team\"",
    detail: "New page → Database → Share → Invite",
  },
  {
    icon: Ticket,
    name: "Jira",
    category: "Project Mgmt",
    example: "\"Move ticket SP-142 to In Progress\"",
    detail: "Board → Find ticket → Drag or status change",
  },
  {
    icon: Table2,
    name: "Google Sheets",
    category: "Spreadsheets",
    example: "\"Add a SUM formula to column D\"",
    detail: "Select cell → formula bar → type and confirm",
  },
  {
    icon: GraduationCap,
    name: "University Portal",
    category: "Education",
    example: "\"Register for CS401 next semester\"",
    detail: "Search → Section → Enroll → Confirm",
  },
  {
    icon: Building2,
    name: "Enterprise Tools",
    category: "Business",
    example: "\"Submit my expense report for last week\"",
    detail: "Works on SAP, Salesforce, ServiceNow, and internal tools",
  },
  {
    icon: Globe,
    name: "Any Website",
    category: "Universal",
    example: "Works on any URL you have open in Chrome",
    detail: "No per-site setup, no allow-list, no configuration",
  },
];

export default function UseCases() {
  return (
    <section
      id="use-cases"
      className="relative py-32 bg-white border-t border-black/[0.05]"
    >
      <div className="max-w-[1280px] mx-auto px-6">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
          className="text-center max-w-2xl mx-auto mb-16"
        >
          <p className="text-[11px] text-[#10B981] uppercase tracking-[0.12em] font-semibold mb-4">
            Use Cases
          </p>
          <h2 className="text-4xl md:text-5xl font-bold text-[#0F172A] tracking-tight mb-4">
            Works wherever you work
          </h2>
          <p className="text-[#64748B] text-lg leading-relaxed">
            ScreenPilot has no built-in knowledge of any specific app. It reads
            what&apos;s on screen and reasons from there — which means it works on
            anything.
          </p>
        </motion.div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {cases.map((c, i) => {
            const Icon = c.icon;
            return (
              <motion.div
                key={c.name}
                initial={{ opacity: 0, y: 16 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.4, delay: i * 0.06 }}
                className="group p-6 rounded-xl bg-white border border-black/[0.07] hover:border-black/[0.12] hover:shadow-sm transition-all duration-300"
              >
                <div className="flex items-start justify-between mb-4">
                  <div className="w-10 h-10 rounded-lg bg-[#EBF3FE] flex items-center justify-center">
                    <Icon className="w-5 h-5 text-[#2563EB]" />
                  </div>
                  <span className="text-[10px] text-[#64748B] font-medium bg-[#F8FAFC] px-2 py-0.5 rounded-full border border-black/[0.06]">
                    {c.category}
                  </span>
                </div>
                <h3 className="font-semibold text-[#0F172A] text-sm mb-1.5">
                  {c.name}
                </h3>
                <p className="text-[#64748B] text-xs italic mb-2 leading-relaxed">
                  {c.example}
                </p>
                <p className="text-[#94A3B8] text-[11px] font-mono leading-relaxed">
                  {c.detail}
                </p>
              </motion.div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
