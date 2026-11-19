// The product side of the boundary: theme, locale data, routes and the Home screen. It never builds a MaterialApp
// (the harness owns the one MaterialApp) and never imports the harness. test/boundary.check.mjs holds both rules.
import 'package:flutter/material.dart';
import 'home.dart';

class ErusProduct {
  const ErusProduct();

  ThemeData get theme => ThemeData(useMaterial3: true, colorSchemeSeed: const Color(0xFF2743EE));
  Iterable<LocalizationsDelegate<dynamic>> get localizationsDelegates => const [];
  Iterable<Locale> get supportedLocales => const [Locale('en', 'US')];
  String get initialRoute => '/';
  Route<dynamic> onGenerateRoute(RouteSettings s, {HomeEvent? onEvent}) =>
      MaterialPageRoute<void>(settings: s, builder: (_) => HomeScreen(onEvent: onEvent));
}
