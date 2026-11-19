import 'package:flutter/material.dart';

// Fake data. Shape follows CHE-6290 S2 Home: net worth, money on hand, month spent vs budget, last 10 transactions.
const _tx = [
  ('Highlands Coffee', 'Food & drink', -58000),
  ('Salary', 'Income', 24000000),
  ('Grab', 'Transport', -74000),
  ('Circle K', 'Groceries', -132000),
  ('Netflix', 'Subscriptions', -260000),
  ('Winmart', 'Groceries', -418000),
  ('Phở 24', 'Food & drink', -85000),
  ('Electric bill', 'Utilities', -890000),
  ('Gym', 'Health', -500000),
  ('Cinema', 'Fun', -180000),
];

String vnd(int v) {
  final s = v.abs().toString().replaceAllMapped(RegExp(r'\B(?=(\d{3})+(?!\d))'), (_) => '.');
  return '${v < 0 ? '-' : '+'}$s ₫';
}

/// Called with every text the note field holds, and every tap on Add. The harness wires these to its bridge;
/// the product only knows "a callback".
typedef HomeEvent = void Function(String name, Map<String, Object?> data);

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key, this.onEvent});
  final HomeEvent? onEvent;
  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  int taps = 0;
  final note = TextEditingController();

  @override
  void dispose() {
    note.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return Scaffold(
      backgroundColor: const Color(0xFFF6F7FB),
      body: SafeArea(
        child: ListView(padding: const EdgeInsets.all(20), children: [
          const Text('Home', style: TextStyle(fontSize: 28, fontWeight: FontWeight.w700)),
          const SizedBox(height: 16),
          Semantics(
            identifier: 'erus-net-worth',
            child: Card(
              color: cs.primary,
              child: Padding(
                padding: const EdgeInsets.all(20),
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text('Net worth', style: TextStyle(color: cs.onPrimary.withValues(alpha: .8))),
                  Text('1.248.600.000 ₫', style: TextStyle(color: cs.onPrimary, fontSize: 30, fontWeight: FontWeight.w700)),
                  const SizedBox(height: 8),
                  Text('On hand 86.420.000 ₫', style: TextStyle(color: cs.onPrimary)),
                ]),
              ),
            ),
          ),
          Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                const Text('This month', style: TextStyle(fontWeight: FontWeight.w600)),
                const SizedBox(height: 8),
                const LinearProgressIndicator(value: .62, minHeight: 8),
                const SizedBox(height: 8),
                const Text('Spent 12.4M of 20M budget'),
                const SizedBox(height: 8),
                TextField(
                  key: const Key('note'),
                  controller: note,
                  decoration: const InputDecoration(labelText: 'Note', border: OutlineInputBorder(), isDense: true),
                  onChanged: (v) => widget.onEvent?.call('text', {'value': v}),
                ),
                const SizedBox(height: 8),
                Semantics(
                  identifier: 'erus-add',
                  child: FilledButton(
                    onPressed: () {
                      setState(() => taps++);
                      widget.onEvent?.call('tap', {'taps': taps});
                    },
                    child: Text('Add ($taps)'),
                  ),
                ),
              ]),
            ),
          ),
          const Padding(
            padding: EdgeInsets.only(top: 8, bottom: 4),
            child: Text('Recent', style: TextStyle(fontWeight: FontWeight.w600)),
          ),
          Semantics(
            identifier: 'erus-recent',
            child: Column(children: [
              for (final t in _tx)
                ListTile(
                  dense: true,
                  title: Text(t.$1),
                  subtitle: Text(t.$2),
                  trailing: Text(vnd(t.$3), style: TextStyle(color: t.$3 < 0 ? Colors.black87 : Colors.green.shade700)),
                ),
            ]),
          ),
        ]),
      ),
    );
  }
}
