                                // EDTP deviation WD-4. Points PID Provider trust at a list we
                                // publish, which carries the seven notified development PID
                                // anchors *plus* our development PID Provider CA — see
                                // tools/test-wallet/deviations.md and scripts/make-test-lote.mjs.
                                //
                                // `pidProviders` is a single Uri, so this REPLACES the notified
                                // list rather than adding to it; the list at the other end is what
                                // makes it additive. A PID signed under our CA is test data from a
                                // development platform, and this build is a MODIFIED wallet.
                                //
                                // The URL is substituted by build.sh from --pid-lote.
                                pidProviders = Uri("__EDTP_PID_LOTE__"),
