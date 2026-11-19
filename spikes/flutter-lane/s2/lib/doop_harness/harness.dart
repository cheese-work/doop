// The harness: the one MaterialApp, the iPhone shell drawn by Rive below and above the product, and the slot between.
// Query flags (read from the embedding page): factory=flutter|rive  anim=drift  frames=N  probe=1  step=1  scale=0.9
import 'dart:convert';
import 'dart:math' as math;
import 'dart:typed_data';
import 'package:flutter/foundation.dart' show kIsWasm;
import 'package:flutter/gestures.dart' show PointerDeviceKind;
import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
import 'package:rive/rive.dart' as rive;
import 'package:web/web.dart' as web;
import 'dart:js_interop';
import '../erus_home/product.dart';
import 'bridge.dart';

/// What make-shell.mjs measured from the .riv: artboard size, the screen node, its corner radius.
class DeviceSpec {
  DeviceSpec(Map<String, dynamic> j)
      : aw = (j['artboard']['w'] as num).toDouble(),
        ah = (j['artboard']['h'] as num).toDouble(),
        sx = (j['screen']['x'] as num).toDouble(),
        sy = (j['screen']['y'] as num).toDouble(),
        sw = (j['screen']['w'] as num).toDouble(),
        sh = (j['screen']['h'] as num).toDouble(),
        radius = (j['screen']['radius'] as num).toDouble();
  final double aw, ah, sx, sy, sw, sh, radius;
}

/// Home as an iPhone 16 Pro app sees it: iOS platform, drag with any pointer, 62 pt top and 34 pt bottom inset.
const kInsets = EdgeInsets.fromLTRB(0, 62, 0, 34);

class _IosScroll extends MaterialScrollBehavior {
  const _IosScroll();
  @override
  TargetPlatform getPlatform(BuildContext context) => TargetPlatform.iOS;
  @override
  Set<PointerDeviceKind> get dragDevices => PointerDeviceKind.values.toSet();
}

Map<String, String> _query() {
  try {
    return Uri.parse(web.window.parent!.location.href).queryParameters;
  } catch (_) {
    return {};
  }
}

Future<Uint8List> _bytes(String url) async {
  final res = await web.window.fetch(url.toJS).toDart;
  if (!res.ok) throw 'GET $url: ${res.status}';
  return (await res.arrayBuffer().toDart).toDart.asUint8List();
}

Future<void> runDoop(ErusProduct product) async {
  WidgetsFlutterBinding.ensureInitialized();
  final q = _query();
  final spec = DeviceSpec(jsonDecode(utf8.decode(await _bytes('/blob/shell.json'))) as Map<String, dynamic>);
  await rive.RiveNative.init();
  final factory = q['factory'] == 'rive' ? rive.Factory.rive : rive.Factory.flutter;
  Future<rive.RiveWidgetController> layer(String f) async =>
      rive.RiveWidgetController((await rive.File.decode(await _bytes('/blob/$f'), riveFactory: factory))!);
  final below = await layer('shell-below.riv');
  final above = await layer('shell-above.riv');
  runApp(DoopHarness(
    product: product,
    spec: spec,
    below: below,
    above: above,
    flags: {...q, 'factory': q['factory'] ?? 'flutter'},
  ));
}

class DoopHarness extends StatelessWidget {
  const DoopHarness({
    super.key,
    required this.product,
    required this.spec,
    required this.below,
    required this.above,
    required this.flags,
  });
  final ErusProduct product;
  final DeviceSpec spec;
  final rive.RiveWidgetController below, above;
  final Map<String, String> flags;

  @override
  Widget build(BuildContext context) => MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: product.theme.copyWith(platform: TargetPlatform.iOS),
        locale: const Locale('en', 'US'),
        localizationsDelegates: product.localizationsDelegates,
        supportedLocales: product.supportedLocales,
        scrollBehavior: const _IosScroll(),
        home: Material(
          color: const Color(0xFF808080),
          child: DeviceStage(product: product, spec: spec, below: below, above: above, flags: flags),
        ),
      );
}

class DeviceStage extends StatefulWidget {
  const DeviceStage({
    super.key,
    required this.product,
    required this.spec,
    required this.below,
    required this.above,
    required this.flags,
  });
  final ErusProduct product;
  final DeviceSpec spec;
  final rive.RiveWidgetController below, above;
  final Map<String, String> flags;
  @override
  State<DeviceStage> createState() => _DeviceStageState();
}

class _DeviceStageState extends State<DeviceStage> with SingleTickerProviderStateMixin {
  int n = 0; // frame counter, painted into the page so a captured frame says which frame it is
  Ticker? _ticker;
  final trace = <List<num>>[]; // [frame, scale, slot left, slot top, slot width, ticker ms] per frame, page coordinates
  int _ms = 0;
  bool _ready = false;
  // A component's worldTransform reads as identity until Rive has drawn one frame. Build once, then read it again.
  bool _settled = false;
  Rect? _slotPage; // the slot in page coordinates, as of the last layout
  late final rive.Component? _screen = widget.above.artboard.component('doop-screen');

  bool get drift => widget.flags['anim'] == 'drift';
  bool get step => widget.flags['step'] == '1';
  int get frames => int.tryParse(widget.flags['frames'] ?? '') ?? 0;

  /// 240 frames per breath: the device box swings between 78 % and 100 % of the artboard size.
  static double scaleAt(int n) => 0.78 + 0.22 * (0.5 + 0.5 * math.cos(2 * math.pi * n / 240));

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) setState(() => _settled = true);
    });
    // `doop:nodes` asks for the Home widgets that carry Semantics(identifier:), as rects in product points.
    web.window.addEventListener(
      'message',
      ((web.MessageEvent e) {
        final d = e.data.dartify();
        if (d is Map && d['type'] == 'doop:nodes') _postNodes();
      }).toJS,
    );
    if (drift) {
      // frames=N ends the run after frame N has painted: the trace goes out with every row it holds
      void tick(int ms) {
        _ms = ms;
        setState(() => n++);
        if (frames > 0 && n == frames) {
          WidgetsBinding.instance.addPostFrameCallback((_) {
            for (var i = 0; i < trace.length; i += 100) {
              post('doop:flutter-trace', {'from': i, 'rows': trace.sublist(i, math.min(i + 100, trace.length))});
            }
            post('doop:flutter-trace-end', {'rows': trace.length});
            _ticker?.stop();
          });
        } else if (step) {
          WidgetsBinding.instance.addPostFrameCallback((_) => post('doop:flutter-stepped', {'n': n}));
        }
      }

      _ticker = createTicker((elapsed) => tick(elapsed.inMilliseconds));
      // `doop:go` starts the animation, `doop:step` (step=1) advances it one frame: the outer page controls the clock,
      // so a capture can start before frame 0, or take a lossless screenshot of every frame.
      web.window.addEventListener(
        'message',
        ((web.MessageEvent e) {
          final d = e.data.dartify();
          if (d is! Map) return;
          if (d['type'] == 'doop:go' && !step && !(_ticker?.isActive ?? true)) _ticker!.start();
          if (d['type'] == 'doop:step' && step) tick(DateTime.now().millisecondsSinceEpoch);
        }).toJS,
      );
    }
  }

  /// Flutter web builds its Semantics tree only once asked: clicking the placeholder switches it on. Each node with an
  /// identifier shows up as `flt-semantics-identifier` in the DOM, positioned by the engine in page pixels. The rect goes
  /// out in product points, so it stays right when the device box is scaled or moved: slot origin + k * rect is the page.
  void _postNodes() {
    final slot = _slotPage;
    if (slot == null) return;
    final t0 = web.window.performance.now();
    (web.document.querySelector('flt-semantics-placeholder') as web.HTMLElement?)?.click();
    final k = slot.width / widget.spec.sw;
    final els = web.document.querySelectorAll('[flt-semantics-identifier]');
    final nodes = <Map<String, Object?>>[];
    for (var i = 0; i < els.length; i++) {
      final el = els.item(i) as web.Element;
      final r = el.getBoundingClientRect();
      nodes.add({
        'id': el.getAttribute('flt-semantics-identifier'),
        'rect': {'x': (r.x - slot.left) / k, 'y': (r.y - slot.top) / k, 'w': r.width / k, 'h': r.height / k},
      });
    }
    post('doop:flutter-nodes', {
      'nodes': nodes,
      'k': k,
      'slot': {'x': slot.left, 'y': slot.top, 'w': slot.width, 'h': slot.height},
      'ms': web.window.performance.now() - t0,
    });
  }

  @override
  void dispose() {
    _ticker?.dispose();
    _screen?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final spec = widget.spec;
    final page = MediaQuery.sizeOf(context);
    final s = drift ? scaleAt(n) : (double.tryParse(widget.flags['scale'] ?? '') ?? 1.0);
    final box = Size(spec.aw * s, spec.ah * s);
    final boxOrigin = Offset((page.width - box.width) / 2, (page.height - box.height) / 2);
    return Stack(children: [
      Positioned.fromRect(
        rect: boxOrigin & box,
        child: _Device(
          spec: spec,
          below: widget.below,
          above: widget.above,
          screen: _screen,
          probe: widget.flags['probe'] == '1',
          child: Navigator(
            onGenerateRoute: (r) => widget.product.onGenerateRoute(r, onEvent: (name, d) => post('doop:flutter-$name', d)),
          ),
          onSlot: (slot, tracked) {
            final pageSlot = slot.shift(boxOrigin);
            _slotPage = pageSlot;
            if (drift) trace.add([n, s, pageSlot.left, pageSlot.top, pageSlot.width, _ms]);
            if (!_ready && _settled) {
              _ready = true;
              WidgetsBinding.instance.addPostFrameCallback((_) => post('doop:flutter-ready', {
                    'harness': 'doop',
                    'factory': widget.flags['factory'],
                    'renderer': kIsWasm ? 'skwasm' : 'canvaskit',
                    'tracked': tracked,
                    'node': _screen == null
                        ? null
                        : {
                            'wt': _screen!.worldTransform.values.toList(),
                            'x': _screen!.x,
                            'y': _screen!.y,
                          },
                    'slot': {'x': pageSlot.left, 'y': pageSlot.top, 'w': pageSlot.width, 'h': pageSlot.height},
                    'page': {'w': page.width, 'h': page.height},
                    'spec': {'aw': spec.aw, 'ah': spec.ah, 'sx': spec.sx, 'sy': spec.sy, 'sw': spec.sw, 'sh': spec.sh},
                    ...env(),
                  }));
            }
          },
        ),
      ),
      Positioned(left: 0, top: 0, child: _IdStrip(n)),
    ]);
  }
}

/// 16 cells of 6 x 6 logical px, bit i of the frame number, white = 1. Page corner, outside the device.
class _IdStrip extends StatelessWidget {
  const _IdStrip(this.n);
  final int n;
  @override
  Widget build(BuildContext context) => CustomPaint(size: const Size(96, 6), painter: _IdPainter(n));
}

class _IdPainter extends CustomPainter {
  _IdPainter(this.n);
  final int n;
  @override
  void paint(Canvas c, Size s) {
    for (var i = 0; i < 16; i++) {
      c.drawRect(Rect.fromLTWH(i * 6.0, 0, 6, 6), Paint()..color = (n >> i) & 1 == 1 ? Colors.white : Colors.black);
    }
  }

  @override
  bool shouldRepaint(_IdPainter o) => o.n != n;
}

/// Below layer, the product in the slot, above layer. The slot is where the Rive runtime says the screen node
/// is, mapped through the same contain fit the two Rive widgets use, recomputed on every layout.
class _Device extends StatelessWidget {
  const _Device({
    required this.spec,
    required this.below,
    required this.above,
    required this.screen,
    required this.probe,
    required this.child,
    required this.onSlot,
  });
  final DeviceSpec spec;
  final rive.RiveWidgetController below, above;
  final rive.Component? screen;
  final bool probe;
  final Widget child;
  final void Function(Rect slot, bool tracked) onSlot;

  @override
  Widget build(BuildContext context) => LayoutBuilder(builder: (context, c) {
        final k = math.min(c.maxWidth / spec.aw, c.maxHeight / spec.ah);
        final ox = (c.maxWidth - spec.aw * k) / 2, oy = (c.maxHeight - spec.ah * k) / 2;
        var nx = spec.sx, ny = spec.sy;
        if (screen != null) {
          final v = screen!.worldTransform.values;
          nx = v[4];
          ny = v[5];
        }
        final slot = Rect.fromLTWH(ox + k * nx, oy + k * ny, k * spec.sw, k * spec.sh);
        onSlot(slot, screen != null);
        Widget layer(rive.RiveWidgetController ctl) => Positioned.fill(
              child: rive.RiveWidget(controller: ctl, fit: rive.Fit.contain, hitTestBehavior: rive.RiveHitTestBehavior.none),
            );
        return Stack(children: [
          layer(below),
          Positioned.fromRect(
            rect: slot,
            child: FittedBox(
              fit: BoxFit.fill,
              child: SizedBox(
                width: spec.sw,
                height: spec.sh,
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(spec.radius),
                  child: MediaQuery(
                    data: MediaQuery.of(context).copyWith(
                      size: Size(spec.sw, spec.sh),
                      padding: kInsets,
                      viewPadding: kInsets,
                      viewInsets: EdgeInsets.zero,
                    ),
                    child: Stack(children: [
                      Positioned.fill(child: child),
                      if (probe)
                        Positioned.fill(
                          child: IgnorePointer(
                            child: DecoratedBox(
                              decoration: BoxDecoration(border: Border.all(color: const Color(0xFFFF00FF), width: 4)),
                            ),
                          ),
                        ),
                    ]),
                  ),
                ),
              ),
            ),
          ),
          layer(above),
        ]);
      });
}
