import 'package:flutter/material.dart';
import 'package:flutter/foundation.dart' show kIsWasm;
import 'bridge.dart';

// The edit-loop timing script rewrites this line on every save.
const kBuildStamp = 'run-0';

void main() => runApp(const ErusApp());

class ErusApp extends StatelessWidget {
  const ErusApp({super.key});
  @override
  Widget build(BuildContext context) => MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: ThemeData(useMaterial3: true, colorSchemeSeed: const Color(0xFF2743EE)),
        home: const HomeScreen(),
      );
}

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

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});
  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  int taps = 0; // state that hot reload must keep
  bool first = true;

  @override
  Widget build(BuildContext context) {
    // After each painted frame tell the embedder: ready (once) and the stamp now on screen.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (first) {
        first = false;
        post('doop:flutter-ready', {'renderer': kIsWasm ? 'skwasm' : 'canvaskit', 'stamp': kBuildStamp, ...env()});
      }
      post('doop:flutter-frame', {'stamp': kBuildStamp, 'taps': taps});
    });
    final cs = Theme.of(context).colorScheme;
    return Scaffold(
      backgroundColor: const Color(0xFFF6F7FB),
      body: SafeArea(
        child: ListView(padding: const EdgeInsets.all(20), children: [
          Row(children: [
            const Text('Home', style: TextStyle(fontSize: 28, fontWeight: FontWeight.w700)),
            const Spacer(),
            // colour band = pixel-visible proof of the stamp (used for the pixel cross-check)
            Container(width: 28, height: 28, color: Color(0xFF000000 | (kBuildStamp.hashCode & 0xFFFFFF))),
          ]),
          const SizedBox(height: 16),
          Card(
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
                // stateful widget state: tap to change, survives hot reload
                FilledButton(onPressed: () => setState(() => taps++), child: Text('Add ($taps) · $kBuildStamp')),
              ]),
            ),
          ),
          const Padding(
            padding: EdgeInsets.only(top: 8, bottom: 4),
            child: Text('Recent', style: TextStyle(fontWeight: FontWeight.w600)),
          ),
          for (final t in _tx)
            ListTile(
              dense: true,
              title: Text(t.$1),
              subtitle: Text(t.$2),
              trailing: Text(vnd(t.$3), style: TextStyle(color: t.$3 < 0 ? Colors.black87 : Colors.green.shade700)),
            ),
        ]),
      ),
    );
  }
}
