# Copyright (c) 2022, efeone Pvt Ltd and contributors
# For license information, please see license.txt

import frappe
from frappe.utils import cint, cstr, flt, formatdate, getdate, now
from erpnext.accounts.general_ledger import make_gl_entries
from frappe.model.document import Document
from erpnext.controllers.accounts_controller import (
	AccountsController,
	get_supplier_block_status,
	validate_taxes_and_charges,
)
from erpnext.controllers.accounts_controller import AccountsController

class ExpenseEntry(AccountsController):
	def validate(self):
		if self.total_amount == 0:
			frappe.throw(_("Amount cannot be zero"))
		if self.total_amount < 0:
			frappe.throw(_("Amount cannot be negative"))
		self.calculate_total_amount()
		self.set_cost_center()
		# self.calculate_taxes()
		self.set_missing_values()
		self.apply_taxes()
	




	def on_submit(self):
		if self.payment_account:
			self.make_gl_entries()

	def on_cancel(self):
		self.ignore_linked_doctypes = ("GL Entry")
		if self.payment_account:
			self.make_gl_entries(cancel=True)

	def set_cost_center(self):
		if not self.cost_center:
			self.cost_center = frappe.get_cached_value("Company", self.company, "cost_center")

	def calculate_total_amount(self):
		self.total = 0
		self.total_taxable_amount = 0
		for d in self.get("expenses"):
			self.total += flt(d.amount)
			if d.is_taxable:
				self.total_taxable_amount += flt(d.amount)

	def make_gl_entries(self, cancel=False):
		if flt(self.total_amount) > 0:
			gl_entries = self.get_gl_entries()
			make_gl_entries(gl_entries, cancel)

	def set_missing_values(self):
		if not self.posting_date:
			self.posting_date = nowdate()

	def get_gl_entries(self):
		gl_entry = []

		# Payment account entry
		if self.total_amount:
			gl_entry.append(
				self.get_gl_dict(
					{
						"account": self.payment_account,
						"credit": self.total_amount,
						"credit_in_account_currency": self.total_amount,
						"against": ",".join([d.expense_account for d in self.expenses]),
						"against_voucher_type": self.doctype,
						"against_voucher": self.name,
						"cost_center": self.cost_center
					},
					item=self,
				)
			)

		# expense entries
		for data in self.expenses:
			gl_entry.append(
				self.get_gl_dict(
					{
						"account": data.expense_account,
						"debit": data.amount,
						"debit_in_account_currency": data.amount,
						"against": self.payment_account,
						"cost_center": data.cost_center or self.cost_center,
						"remarks": data.description
					},
					item=data,
				)
			)

		self.add_tax_gl_entries(gl_entry)
		return gl_entry

	def add_tax_gl_entries(self, gl_entries):
		for tax in self.get("expense_entry_taxes_and_charges"):
			gl_entries.append(
				self.get_gl_dict(
					{
						"account": tax.account_head,
						"debit": tax.tax_amount,
						"debit_in_account_currency": tax.tax_amount,
						"against": self.payment_account,
						"cost_center": self.cost_center,
						"against_voucher_type": self.doctype,
						"against_voucher": self.name,
					},
					item=tax,
				)
			)

	@frappe.whitelist()
	def calculate_taxes(self):
		self.total_tax_amount = 0
		for tax in self.expense_entry_taxes_and_charges:
			if tax.rate:
				tax.tax_amount = flt(self.total_taxable_amount) * flt(tax.rate / 100)

			tax.total = flt(tax.tax_amount) + flt(self.total_taxable_amount)
			self.total_tax_amount += flt(tax.tax_amount)

		self.total_amount = (
			flt(self.total)
			+ flt(self.total_tax_amount)
		)

	def apply_taxes(self):
			self.initialize_taxes()
			self.determine_exclusive_rate()
			self.calculate_taxes_custom()

	def calculate_taxes_custom(self):
		self.total_taxes_and_charges = 0.0
		self.total_tax_amount = 0.0

		actual_tax_dict = dict(
			[
				[tax.idx, flt(tax.tax_amount, tax.precision("tax_amount"))]
				for tax in self.get("taxes")
				if tax.charge_type == "Actual"
			]
		)

		for i, tax in enumerate(self.get("taxes")):
			current_tax_amount = self.get_current_tax_amount(tax)

			if tax.charge_type == "Actual":
				actual_tax_dict[tax.idx] -= current_tax_amount
				if i == len(self.get("taxes")) - 1:
					current_tax_amount += actual_tax_dict[tax.idx]

			tax.tax_amount = current_tax_amount
			tax.base_tax_amount = current_tax_amount

			if tax.add_deduct_tax == "Deduct":
				current_tax_amount *= -1.0
			else:
				current_tax_amount *= 1.0

			if i == 0:
				tax.total = flt(self.total_amount + current_tax_amount, self.precision("total", tax))
			else:
				tax.total = flt(
					self.get("taxes")[i - 1].total + current_tax_amount, self.precision("total", tax)
				)

			tax.base_total = tax.total
			# بدون اعتبار لنوع الدفع أو العملة
			self.total_taxes_and_charges += current_tax_amount
			self.total_tax_amount += tax.base_tax_amount

		if self.get("taxes"):
			self.total_amount = self.get("taxes")[-1].base_total
	def get_current_tax_amount(self, tax):
		tax_rate = tax.rate

		# To set row_id by default as previous row.
		if tax.charge_type in ["On Previous Row Amount", "On Previous Row Total"]:
			if tax.idx == 1:
				frappe.throw(
					_(
						"Cannot select charge type as 'On Previous Row Amount' or 'On Previous Row Total' for first row"
					)
				)

			if not tax.row_id:
				tax.row_id = tax.idx - 1

		if tax.charge_type == "Actual":
			current_tax_amount = flt(tax.tax_amount, self.precision("tax_amount", tax))
		elif tax.charge_type == "On Paid Amount":
			current_tax_amount = (tax_rate / 100.0) * self.total_amount
		elif tax.charge_type == "On Previous Row Amount":
			current_tax_amount = (tax_rate / 100.0) * self.get("taxes")[cint(tax.row_id) - 1].tax_amount

		elif tax.charge_type == "On Previous Row Total":
			current_tax_amount = (tax_rate / 100.0) * self.get("taxes")[cint(tax.row_id) - 1].total

		return current_tax_amount
	
	def initialize_taxes(self):
			for tax in self.get("taxes"):
				validate_taxes_and_charges(tax)
				validate_inclusive_tax(tax, self)

				tax_fields = ["total", "tax_fraction_for_current_item", "grand_total_fraction_for_current_item"]

				if tax.charge_type != "Actual":
					tax_fields.append("tax_amount")

				for fieldname in tax_fields:
					tax.set(fieldname, 0.0)

			self.total_amount = self.total
	def determine_exclusive_rate(self):
			if not any(cint(tax.included_in_paid_amount) for tax in self.get("taxes")):
				return

			cumulated_tax_fraction = 0
			for i, tax in enumerate(self.get("taxes")):
				tax.tax_fraction_for_current_item = self.get_current_tax_fraction(tax)
				if i == 0:
					tax.grand_total_fraction_for_current_item = 1 + tax.tax_fraction_for_current_item
				else:
					tax.grand_total_fraction_for_current_item = (
						self.get("taxes")[i - 1].grand_total_fraction_for_current_item
						+ tax.tax_fraction_for_current_item
					)

				cumulated_tax_fraction += tax.tax_fraction_for_current_item

			self.total_amount = flt(self.total / (1 + cumulated_tax_fraction))
	
	
	# def set_amounts_after_tax(self):
	# 	applicable_tax = 0
	# 	base_applicable_tax = 0
	# 	for tax in self.get("taxes"):
	# 		if not tax.included_in_paid_amount:
	# 			amount = -1 * tax.tax_amount if tax.add_deduct_tax == "Deduct" else tax.tax_amount
	# 			base_amount = (
	# 				-1 * tax.base_tax_amount if tax.add_deduct_tax == "Deduct" else tax.base_tax_amount
	# 			)

	# 			applicable_tax += amount
	# 			base_applicable_tax += base_amount

	# 	# Safely calculate precision
	# 	paid_amount_precision = self.precision("paid_amount_after_tax") if self.meta.has_field("paid_amount_after_tax") else 2
	# 	base_paid_amount_precision = self.precision("base_paid_amount_after_tax") if self.meta.has_field("base_paid_amount_after_tax") else 2

	# 	self.paid_amount_after_tax = flt(
	# 		flt(self.total) + flt(applicable_tax), paid_amount_precision
	# 	)
	# 	self.base_paid_amount_after_tax = flt(
	# 		flt(self.paid_amount_after_tax) * flt(self.source_exchange_rate),
	# 		base_paid_amount_precision,
	# 	)

	# 	self.received_amount_after_tax = flt(
	# 		flt(self.received_amount) + flt(applicable_tax), paid_amount_precision
	# 	)
	# 	self.base_received_amount_after_tax = flt(
	# 		flt(self.received_amount_after_tax) * flt(self.target_exchange_rate),
	# 		base_paid_amount_precision,
	# 	)


	# def set_amounts_in_company_currency(self):
	# 	self.base_paid_amount, self.base_received_amount, self.difference_amount = 0, 0, 0
	# 	if self.total:
	# 		self.base_paid_amount = flt(
	# 			flt(self.total) * flt(self.source_exchange_rate), self.precision("base_paid_amount")
	# 		)

	# 	if self.received_amount:
	# 		self.base_received_amount = flt(
	# 			flt(self.received_amount) * flt(self.target_exchange_rate),
	# 			self.precision("base_received_amount"),
	# 		)


	def set_amounts(self):
			self.set_amounts_in_company_currency()


@frappe.whitelist()
def get_tax_rate(account):
	return frappe.db.get_value("Account", account, 'tax_rate')

def validate_inclusive_tax(tax, doc):
	def _on_previous_row_error(row_range):
		throw(
			_("To include tax in row {0} in Item rate, taxes in rows {1} must also be included").format(
				tax.idx, row_range
			)
		)

	if cint(getattr(tax, "included_in_paid_amount", None)):
		if tax.charge_type == "Actual":
			# inclusive tax cannot be of type Actual
			throw(
				_("Charge of type 'Actual' in row {0} cannot be included in Item Rate or Paid Amount").format(
					tax.idx
				)
			)
		elif tax.charge_type == "On Previous Row Amount" and not cint(
			doc.get("taxes")[cint(tax.row_id) - 1].included_in_paid_amount
		):
			# referred row should also be inclusive
			_on_previous_row_error(tax.row_id)
		elif tax.charge_type == "On Previous Row Total" and not all(
			[cint(t.included_in_paid_amount for t in doc.get("taxes")[: cint(tax.row_id) - 1])]
		):
			# all rows about the referred tax should be inclusive
			_on_previous_row_error("1 - %d" % (cint(tax.row_id),))
		elif tax.get("category") == "Valuation":
			frappe.throw(_("Valuation type charges can not be marked as Inclusive"))

