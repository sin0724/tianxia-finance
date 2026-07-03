export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export interface Database {
  public: {
    Tables: {
      products: {
        Row: { id: string; name: string; category: string | null; price_vat_incl: number; current_cost: number; active: boolean; created_at: string; updated_at: string }
        Insert: { id?: string; name: string; category?: string | null; price_vat_incl: number; current_cost: number; active?: boolean; created_at?: string; updated_at?: string }
        Update: { id?: string; name?: string; category?: string | null; price_vat_incl?: number; current_cost?: number; active?: boolean; created_at?: string; updated_at?: string }
        Relationships: []
      }
      product_cost_history: {
        Row: { id: string; product_id: string; cost: number; effective_from: string; note: string | null; created_at: string }
        Insert: { id?: string; product_id: string; cost: number; effective_from: string; note?: string | null; created_at?: string }
        Update: { id?: string; product_id?: string; cost?: number; effective_from?: string; note?: string | null; created_at?: string }
        Relationships: []
      }
      employees: {
        Row: { id: string; name: string; position: string | null; employee_type: 'full_time' | 'part_time'; base_salary: number; hourly_wage: number; incentive_type: 'percent' | 'fixed' | null; incentive_value: number; active: boolean; hired_at: string | null; created_at: string; updated_at: string }
        Insert: { id?: string; name: string; position?: string | null; employee_type?: 'full_time' | 'part_time'; base_salary?: number; hourly_wage?: number; incentive_type?: 'percent' | 'fixed' | null; incentive_value?: number; active?: boolean; hired_at?: string | null; created_at?: string; updated_at?: string }
        Update: { id?: string; name?: string; position?: string | null; employee_type?: 'full_time' | 'part_time'; base_salary?: number; hourly_wage?: number; incentive_type?: 'percent' | 'fixed' | null; incentive_value?: number; active?: boolean; hired_at?: string | null; created_at?: string; updated_at?: string }
        Relationships: []
      }
      clients: {
        Row: { id: string; name: string; manager: string | null; contact: string | null; memo: string | null; created_at: string; updated_at: string }
        Insert: { id?: string; name: string; manager?: string | null; contact?: string | null; memo?: string | null; created_at?: string; updated_at?: string }
        Update: { id?: string; name?: string; manager?: string | null; contact?: string | null; memo?: string | null; created_at?: string; updated_at?: string }
        Relationships: []
      }
      expense_categories: {
        Row: { id: string; name: string; parent_type: 'fixed' | 'variable' | 'special'; is_recurring: boolean; is_custom: boolean; active: boolean; created_at: string }
        Insert: { id?: string; name: string; parent_type: 'fixed' | 'variable' | 'special'; is_recurring?: boolean; is_custom?: boolean; active?: boolean; created_at?: string }
        Update: { id?: string; name?: string; parent_type?: 'fixed' | 'variable' | 'special'; is_recurring?: boolean; is_custom?: boolean; active?: boolean; created_at?: string }
        Relationships: []
      }
      representatives: {
        Row: { id: string; name: string; email: string; share_ratio: number; created_at: string }
        Insert: { id?: string; name: string; email: string; share_ratio?: number; created_at?: string }
        Update: { id?: string; name?: string; email?: string; share_ratio?: number; created_at?: string }
        Relationships: []
      }
      settings: {
        Row: { key: string; value: Json; updated_at: string }
        Insert: { key: string; value: Json; updated_at?: string }
        Update: { key?: string; value?: Json; updated_at?: string }
        Relationships: []
      }
      projects: {
        Row: { id: string; client_id: string | null; name: string; total_amount: number; contract_date: string | null; status: 'ongoing' | 'completed' | 'cancelled'; memo: string | null; created_at: string; updated_at: string }
        Insert: { id?: string; client_id?: string | null; name: string; total_amount: number; contract_date?: string | null; status?: 'ongoing' | 'completed' | 'cancelled'; memo?: string | null; created_at?: string; updated_at?: string }
        Update: { id?: string; client_id?: string | null; name?: string; total_amount?: number; contract_date?: string | null; status?: 'ongoing' | 'completed' | 'cancelled'; memo?: string | null; created_at?: string; updated_at?: string }
        Relationships: []
      }
      project_items: {
        Row: { id: string; project_id: string; product_id: string | null; item_name: string | null; quantity: number; unit_price_snapshot: number; unit_cost_snapshot: number; created_at: string }
        Insert: { id?: string; project_id: string; product_id?: string | null; item_name?: string | null; quantity: number; unit_price_snapshot: number; unit_cost_snapshot: number; created_at?: string }
        Update: { id?: string; project_id?: string; product_id?: string | null; item_name?: string | null; quantity?: number; unit_price_snapshot?: number; unit_cost_snapshot?: number; created_at?: string }
        Relationships: []
      }
      payments: {
        Row: { id: string; project_id: string | null; amount: number; payment_date: string; payment_type: '계약금' | '중도금' | '잔금' | '기타' | null; manager: string | null; memo: string | null; source: 'slack' | 'manual'; external_id: string | null; client_name_raw: string | null; matched: boolean; created_at: string; updated_at: string }
        Insert: { id?: string; project_id?: string | null; amount: number; payment_date: string; payment_type?: '계약금' | '중도금' | '잔금' | '기타' | null; manager?: string | null; memo?: string | null; source?: 'slack' | 'manual'; external_id?: string | null; client_name_raw?: string | null; matched?: boolean; created_at?: string; updated_at?: string }
        Update: { id?: string; project_id?: string | null; amount?: number; payment_date?: string; payment_type?: '계약금' | '중도금' | '잔금' | '기타' | null; manager?: string | null; memo?: string | null; source?: 'slack' | 'manual'; external_id?: string | null; client_name_raw?: string | null; matched?: boolean; created_at?: string; updated_at?: string }
        Relationships: []
      }
      monthly_expenses: {
        Row: { id: string; year: number; month: number; category_id: string | null; item_name: string | null; parent_type: string | null; amount: number; memo: string | null; created_at: string }
        Insert: { id?: string; year: number; month: number; category_id?: string | null; item_name?: string | null; parent_type?: string | null; amount: number; memo?: string | null; created_at?: string }
        Update: { id?: string; year?: number; month?: number; category_id?: string | null; item_name?: string | null; parent_type?: string | null; amount?: number; memo?: string | null; created_at?: string }
        Relationships: []
      }
      monthly_incentives: {
        Row: { id: string; year: number; month: number; employee_id: string | null; amount: number; basis: number | null; memo: string | null; created_at: string }
        Insert: { id?: string; year: number; month: number; employee_id?: string | null; amount: number; basis?: number | null; memo?: string | null; created_at?: string }
        Update: { id?: string; year?: number; month?: number; employee_id?: string | null; amount?: number; basis?: number | null; memo?: string | null; created_at?: string }
        Relationships: []
      }
      monthly_payroll: {
        Row: { id: string; year: number; month: number; employee_id: string | null; base_salary: number; deductions: number; incentive_deductions: number; net_pay: number; work_hours: number; include_weekly_holiday: boolean; paid_at: string | null; created_at: string }
        Insert: { id?: string; year: number; month: number; employee_id?: string | null; base_salary: number; deductions?: number; incentive_deductions?: number; net_pay: number; work_hours?: number; include_weekly_holiday?: boolean; paid_at?: string | null; created_at?: string }
        Update: { id?: string; year?: number; month?: number; employee_id?: string | null; base_salary?: number; deductions?: number; incentive_deductions?: number; net_pay?: number; work_hours?: number; include_weekly_holiday?: boolean; paid_at?: string | null; created_at?: string }
        Relationships: []
      }
      monthly_settlements: {
        Row: { id: string; year: number; month: number; total_revenue: number; supply_value: number; total_incentive: number; total_product_cost: number; gross_profit: number; total_fixed_cost: number; total_variable_cost: number; total_special_cost: number; total_payroll: number; operating_profit: number; corporate_tax_reserve: number; retained_earnings: number; distributable_profit: number; representative_share: number; calculated_at: string }
        Insert: { id?: string; year: number; month: number; total_revenue: number; supply_value: number; total_incentive?: number; total_product_cost?: number; gross_profit: number; total_fixed_cost?: number; total_variable_cost?: number; total_special_cost?: number; total_payroll?: number; operating_profit: number; corporate_tax_reserve?: number; retained_earnings?: number; distributable_profit: number; representative_share: number; calculated_at?: string }
        Update: { id?: string; year?: number; month?: number; total_revenue?: number; supply_value?: number; total_incentive?: number; total_product_cost?: number; gross_profit?: number; total_fixed_cost?: number; total_variable_cost?: number; total_special_cost?: number; total_payroll?: number; operating_profit?: number; corporate_tax_reserve?: number; retained_earnings?: number; distributable_profit?: number; representative_share?: number; calculated_at?: string }
        Relationships: []
      }
    }
    Views: { [_ in never]: never }
    Functions: { [_ in never]: never }
    Enums: { [_ in never]: never }
    CompositeTypes: { [_ in never]: never }
  }
}

// 편의 타입 alias
export type Product = Database['public']['Tables']['products']['Row']
export type ProductCostHistory = Database['public']['Tables']['product_cost_history']['Row']
export type Employee = Database['public']['Tables']['employees']['Row']
export type Client = Database['public']['Tables']['clients']['Row']
export type ExpenseCategory = Database['public']['Tables']['expense_categories']['Row']
export type Representative = Database['public']['Tables']['representatives']['Row']
export type Settings = Database['public']['Tables']['settings']['Row']
export type Project = Database['public']['Tables']['projects']['Row']
export type ProjectItem = Database['public']['Tables']['project_items']['Row']
export type Payment = Database['public']['Tables']['payments']['Row']
export type MonthlyExpense = Database['public']['Tables']['monthly_expenses']['Row']
export type MonthlyIncentive = Database['public']['Tables']['monthly_incentives']['Row']
export type MonthlyPayroll = Database['public']['Tables']['monthly_payroll']['Row']
export type MonthlySettlement = Database['public']['Tables']['monthly_settlements']['Row']
