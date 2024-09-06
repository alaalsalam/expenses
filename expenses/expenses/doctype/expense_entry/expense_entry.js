// Copyright (c) 2022, efeone Pvt Ltd and contributors
// For license information, please see license.txt

frappe.ui.form.on('Expense Entry', {
	refresh:function(frm){
		erpnext.hide_company();
		frm.events.show_general_ledger(frm);

		
	},
	setup: function(frm) {
		frm.set_query("payment_account", function() {
			frm.events.validate_company(frm);
			var account_types = ["Bank", "Cash"];
			return {
				filters: {
					"account_type": ["in", account_types],
					"is_group": 0,
					"company": frm.doc.company
				}
			}
		});

		frm.set_query("account_head", "expense_entry_taxes_and_charges", function() {
			return {
				filters: [
					['company', '=', frm.doc.company],
					['is_group', '=', 0],
					['account_type', 'in', ["Tax", "Chargeable", "Income Account","Expense Account", "Expenses Included In Valuation"]]
				]
			};
		});
		frm.set_query("expense_account", "expenses", function() {
			return {
				filters: [
					['company', '=', frm.doc.company],
					['is_group', '=', 0],
					['account_type', 'in', ["Tax", "Chargeable", "Income Account", "Expenses Included In Valuation"]]
				]
			};
		});
	},
	mode_of_payment:function(frm){
		if(frm.doc.mode_of_payment){
			get_payment_mode_account(frm, frm.doc.mode_of_payment, function(account){
					frm.set_value('payment_account', account)
			});
		}
	},
	validate_company: (frm) => {
		if (!frm.doc.company){
			frappe.throw({message:__("Please select a Company first."), title: __("Mandatory")});
		}
	},

	calculate_grand_total: function(frm) {
		var grand_total = flt(frm.doc.total) + flt(frm.doc.total_tax_amount);
		frm.set_value("total_amount", grand_total);
		frm.refresh_fields();
	},

	show_general_ledger: function(frm) {
		if(frm.doc.docstatus > 0) {
			frm.add_custom_button(__('Ledger'), function() {
				frappe.route_options = {
					"voucher_no": frm.doc.name,
					"from_date": frm.doc.posting_date,
					"to_date": moment(frm.doc.modified).format('YYYY-MM-DD'),
					"company": frm.doc.company,
					"group_by": "",
					"show_cancelled_entries": frm.doc.docstatus === 2
				};
				frappe.set_route("query-report", "General Ledger");
			}, "fa fa-table");
		}
	},

	payment_account: function(frm){
		set_account_currency_and_balance(frm, frm.doc.payment_account)
	},
	get_taxes: function(frm) {
		if(frm.doc.taxes) {
			frappe.call({
				method: "calculate_taxes",
				doc: frm.doc,
				callback: () => {
					refresh_field("expense_entry_taxes_and_charges");
					frm.trigger("calculate_grand_total");
				}
			});
		}
	},
	cost_center: function(frm) {
		frm.events.set_child_cost_center(frm);
	},

	validate: function(frm) {
		frm.events.set_child_cost_center(frm);
	},

	set_child_cost_center: function(frm){
		(frm.doc.expenses || []).forEach(function(d) {
			if (!d.cost_center){
				d.cost_center = frm.doc.cost_center;
			}
		});
	},
	fetch_taxes_from_template: function (frm) {
		let master_doctype = "";
		let taxes_and_charges = "";

		if (frm.doc.party_type == "Supplier") {
			master_doctype = "Purchase Taxes and Charges Template";
			taxes_and_charges = frm.doc.purchase_taxes_and_charges_template;
		} else if (frm.doc.party_type == "Customer") {
			master_doctype = "Sales Taxes and Charges Template";
			taxes_and_charges = frm.doc.sales_taxes_and_charges_template;
		}

		if (!taxes_and_charges) {
			return;
		}

		frappe.call({
			method: "erpnext.controllers.accounts_controller.get_taxes_and_charges",
			args: {
				master_doctype: master_doctype,
				master_name: taxes_and_charges,
			},
			callback: function (r) {
				if (!r.exc && r.message) {
					// set taxes table
					if (r.message) {
						for (let tax of r.message) {
							if (tax.charge_type === "On Net Total") {
								tax.charge_type = "On Paid Amount";
							}
							frm.add_child("taxes", tax);
						}
						frm.events.apply_taxes(frm);
						frm.events.set_unallocated_amount(frm);
					}
				}
			},
		});
	},
	apply_taxes: function (frm) {
		frm.events.initialize_taxes(frm);
		frm.events.determine_exclusive_rate(frm);
		frm.events.calculate_taxes(frm);
	},
	determine_exclusive_rate: function (frm) {
		let has_inclusive_tax = false;
		$.each(frm.doc["taxes"] || [], function (i, row) {
			if (cint(row.included_in_paid_amount)) has_inclusive_tax = true;
		});
		if (has_inclusive_tax == false) return;

		let cumulated_tax_fraction = 0.0;
		$.each(frm.doc["taxes"] || [], function (i, tax) {
			tax.tax_fraction_for_current_item = frm.events.get_current_tax_fraction(frm, tax);

			if (i == 0) {
				tax.grand_total_fraction_for_current_item = 1 + tax.tax_fraction_for_current_item;
			} else {
				tax.grand_total_fraction_for_current_item =
					frm.doc["taxes"][i - 1].grand_total_fraction_for_current_item +
					tax.tax_fraction_for_current_item;
			}

			cumulated_tax_fraction += tax.tax_fraction_for_current_item;
			frm.doc.total_amount = flt(frm.doc.base_paid_amount / (1 + cumulated_tax_fraction));
		});
	},
	initialize_taxes: function (frm) {
		$.each(frm.doc["taxes"] || [], function (i, tax) {
			frm.events.validate_taxes_and_charges(tax);
			frm.events.validate_inclusive_tax(tax);
			tax.item_wise_tax_detail = {};
			let tax_fields = [
				"total",
				"tax_fraction_for_current_item",
				"grand_total_fraction_for_current_item",
			];

			if (cstr(tax.charge_type) != "Actual") {
				tax_fields.push("tax_amount");
			}

			$.each(tax_fields, function (i, fieldname) {
				tax[fieldname] = 0.0;
			});

			frm.doc.total_amount = frm.doc.base_paid_amount;
		});
	},
	calculate_taxes: function (frm) {
		frm.doc.total_taxes_and_charges = 0.0;
		frm.doc.base_total_taxes_and_charges = 0.0;

		let company_currency = frappe.get_doc(":Company", frm.doc.company).default_currency;
		let actual_tax_dict = {};

		// maintain actual tax rate based on idx
		$.each(frm.doc["taxes"] || [], function (i, tax) {
			if (tax.charge_type == "Actual") {
				actual_tax_dict[tax.idx] = flt(tax.tax_amount, precision("tax_amount", tax));
			}
		});

		$.each(frm.doc["taxes"] || [], function (i, tax) {
			let current_tax_amount = frm.events.get_current_tax_amount(frm, tax);

			// Adjust divisional loss to the last item
			if (tax.charge_type == "Actual") {
				actual_tax_dict[tax.idx] -= current_tax_amount;
				if (i == frm.doc["taxes"].length - 1) {
					current_tax_amount += actual_tax_dict[tax.idx];
				}
			}

			// tax accounts are only in company currency
			tax.base_tax_amount = current_tax_amount;
			current_tax_amount *= tax.add_deduct_tax == "Deduct" ? -1.0 : 1.0;

			if (i == 0) {
				tax.total = flt(frm.doc.total_amount + current_tax_amount, precision("total", tax));
			} else {
				tax.total = flt(frm.doc["taxes"][i - 1].total + current_tax_amount, precision("total", tax));
			}

			// tac accounts are only in company currency
			tax.base_total = tax.total;

			// calculate total taxes and base total taxes
			if (frm.doc.payment_type == "Pay") {
				// tax accounts only have company currency
				if (tax.currency != frm.doc.paid_to_account_currency) {
					//total_taxes_and_charges has the target currency. so using target conversion rate
					frm.doc.total_taxes_and_charges += flt(current_tax_amount / frm.doc.target_exchange_rate);
				} else {
					frm.doc.total_taxes_and_charges += current_tax_amount;
				}
			} else if (frm.doc.payment_type == "Receive") {
				if (tax.currency != frm.doc.paid_from_account_currency) {
					//total_taxes_and_charges has the target currency. so using source conversion rate
					frm.doc.total_taxes_and_charges += flt(current_tax_amount / frm.doc.source_exchange_rate);
				} else {
					frm.doc.total_taxes_and_charges += current_tax_amount;
				}
			}

			frm.doc.total_tax_amount += tax.base_tax_amount;

			frm.refresh_field("taxes");
			frm.refresh_field("total_taxes_and_charges");
			frm.refresh_field("total_tax_amount");
		});
	},
	taxes: function(frm) {
        frm.events.calculate_taxes(frm); // إعادة حساب الضرائب
        frm.refresh_field('total'); // تحديث الحقل total تلقائيًا
    },
	
});

frappe.ui.form.on('Expense Entry Item', {
	amount: function(frm, cdt, cdn) {
		cur_frm.cscript.calculate_total(frm.doc, cdt, cdn);
		frm.trigger("get_taxes");
		frm.trigger("calculate_grand_total");
	},
	items_remove: function(frm, cdt, cdn){
		cur_frm.cscript.calculate_total(frm.doc, cdt, cdn);
		frm.trigger("get_taxes");
		frm.trigger("calculate_grand_total");
	},
	is_taxable: function(frm, cdt, cdn){
		cur_frm.cscript.calculate_total(frm.doc, cdt, cdn);
		frm.trigger("get_taxes");
		frm.trigger("calculate_grand_total");
	},
	cost_center: function(frm, cdt, cdn) {
		erpnext.utils.copy_value_in_all_rows(frm.doc, cdt, cdn, "expenses", "cost_center");
	}
});

let get_payment_mode_account = function(frm, mode_of_payment, callback) {
	if(!frm.doc.company) {
		frappe.throw(__('Please select the Company first'));
	}
	if(!mode_of_payment) {
		return;
	}
	return  frappe.call({
		method: 'erpnext.accounts.doctype.sales_invoice.sales_invoice.get_bank_cash_account',
		args: {
			'mode_of_payment': mode_of_payment,
			'company': frm.doc.company
		},
		callback: function(r, rt) {
			if(r.message) {
				callback(r.message.account)
			}
		}
	});
}


cur_frm.cscript.validate = function(doc) {
	cur_frm.cscript.calculate_total(doc);
};

cur_frm.cscript.calculate_total = function(doc){
	doc.total_quantity = 0;
	doc.total = 0;
	doc.total_taxable_amount = 0;
	$.each((doc.expenses || []), function(i, d) {
		doc.total += d.amount;
		doc.total_quantity += 1;
		if(d.is_taxable){
			doc.total_taxable_amount += d.amount;
		}
	});
};

cur_frm.fields_dict['cost_center'].get_query = function(doc) {
	return {
		filters: {
			"company": doc.company
		}
	}
};
frappe.ui.form.on("Expense Entry Taxes and Charges", {
	account_head: function(frm, cdt, cdn) {
		var child = locals[cdt][cdn];
		if(child.account_head && !child.description) {
			// set description from account head
			child.description = child.account_head.split(' - ').slice(0, -1).join(' - ');
		}
		if(child.account_head){
			frappe.call({
				method: "expenses.expenses.doctype.expense_entry.expense_entry.get_tax_rate",
				args: {
					"account": child.account_head
				},
				callback: function(r, ) {
					if(r.message) {
						child.rate = r.message;
					}
					refresh_field("expense_entry_taxes_and_charges");
				}
			});
		}
		refresh_field("expense_entry_taxes_and_charges");
	},

	calculate_total_tax: function(frm, cdt, cdn) {
		var child = locals[cdt][cdn];
		child.total = flt(frm.doc.total_taxable_amount) + flt(child.tax_amount);
		frm.trigger("calculate_tax_amount", cdt, cdn);
	},

	calculate_tax_amount: function(frm) {
		frm.doc.total_tax_amount = 0;
		(frm.doc.taxes || []).forEach(function(d) {
			frm.doc.total_tax_amount += d.tax_amount;
		});
		frm.trigger("calculate_grand_total");
	},

	rate: function(frm, cdt, cdn) {
		var child = locals[cdt][cdn];
		if(!child.amount) {
			child.tax_amount = flt(frm.doc.total_taxable_amount) * (flt(child.rate)/100);
		}
		frm.trigger("calculate_total_tax", cdt, cdn);
	},

	tax_amount: function(frm, cdt, cdn) {
		frm.trigger("calculate_total_tax", cdt, cdn);
	}
});

let set_account_currency_and_balance = function(frm, account) {
	if (frm.doc.posting_date && account) {
		frappe.call({
			method: "erpnext.accounts.doctype.payment_entry.payment_entry.get_account_details",
			args: {
				"account": account,
				"date": frm.doc.posting_date,
				"cost_center": frm.doc.cost_center
			},
			callback: function(r, ) {
				if(r.message) {
					frappe.run_serially([
						() => frm.set_value('account_currency', r.message['account_currency']),
						() => {
							frm.set_value('payment_account_balance', r.message['account_balance']);
						}
					]);
				}
			}
		});
	}
}

let get_tax_rate = function(account) {
	if (account) {
		frappe.call({
			method: "expenses.expenses.doctype.expense_entry.expense_entry.get_tax_rate",
			args: {
				"account": account
			},
			callback: function(r, ) {
				if(r.message) {
					return r.message
				}
			}
		});
	}
}

frappe.ui.form.on("Advance Taxes and Charges", {
	rate: function (frm) {
		frm.events.apply_taxes(frm);
		frm.events.set_unallocated_amount(frm);
	},

	tax_amount: function (frm) {
		frm.events.apply_taxes(frm);
		frm.events.set_unallocated_amount(frm);
	},

	row_id: function (frm) {
		frm.events.apply_taxes(frm);
		frm.events.set_unallocated_amount(frm);
	},

	taxes_remove: function (frm) {
		frm.events.apply_taxes(frm);
		frm.events.set_unallocated_amount(frm);
	},

	included_in_paid_amount: function (frm) {
		frm.events.apply_taxes(frm);
		frm.events.set_unallocated_amount(frm);
	},

	charge_type: function (frm) {
		frm.events.apply_taxes(frm);
		frm.events.set_unallocated_amount(frm);
	},
});