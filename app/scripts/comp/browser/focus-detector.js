import Backbone from 'backbone';
import { Launcher } from 'comp/launcher';
import { Features } from 'util/features';

const FocusDetector = {
    init() {
        this.isFocused = true;
        this.detectsFocusWithEvents = !Features.isDesktop && !Features.isMobile;
        if (this.detectsFocusWithEvents) {
            window.addEventListener('focus', () => {
                if (!FocusDetector.isFocused) {
                    FocusDetector.isFocused = true;
                    Backbone.trigger('main-window-focus');
                }
            });
            window.addEventListener('blur', () => {
                if (FocusDetector.isFocused) {
                    FocusDetector.isFocused = false;
                    Backbone.trigger('main-window-blur');
                }
            });
        }
    },

    hasFocus() {
        if (this.detectsFocusWithEvents) {
            return this.isFocused;
        } else if (Launcher) {
            return Launcher.isAppFocused();
        } else {
            return true;
        }
    }
};

export { FocusDetector };
