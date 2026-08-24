# Ruby 3.2 removed String#tainted?/#untaint, which this project's pinned
# Liquid/Jekyll versions still call. The github-pages gem also forces Jekyll's
# "safe mode" on unconditionally, which blocks _plugins/*.rb from loading at
# all (including _plugins/ruby32_compat.rb), so the patch has to be applied
# here, before Jekyll even boots, instead of via a plugin.
class Object
  def tainted?
    false
  end

  def untaint
    self
  end
end

load Gem.bin_path("jekyll", "jekyll")
